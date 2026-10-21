/**
 * POST /api/compliance/obligations/[id]/review (phase2_spec.md G.7).
 *
 * The reviewer is the holder of the TEMPLATE's reviewerRole, resolved
 * live - never the submitter, never a stored snapshot. Accept: the
 * obligation completes via 'review'. Reject: it returns to 'due' with
 * its ORIGINAL dueDate (never recomputed, never extended) so the ladder
 * and overdue clock keep running from the real deadline; a rejection
 * note is mandatory.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, loadObligation } from '@/lib/server/compliance/access';
import { userHoldsRole } from '@/lib/server/role-holders';
import { assertLegalTransition, IllegalTransitionError } from '@/lib/server/compliance/transitions';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { tsToDate } from '@/lib/server/compliance/cron';
import type { ObligationStatus } from '@/lib/compliance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const obligation = await loadObligation(db, id);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    const data = obligation.data;

    const templateSnap = await db.collection('compliance_templates').doc(data.templateKey as string).get();
    if (!templateSnap.exists) return errorJson(409, 'TEMPLATE_MISSING');
    const reviewerRole = templateSnap.data()?.reviewerRole as string;
    const chapterId = (data.chapterId as string | null) ?? null;
    if (!(await userHoldsRole(uid, reviewerRole, chapterId ?? undefined))) {
      return errorJson(403, 'FORBIDDEN');
    }

    const body = (await req.json().catch(() => ({}))) as { outcome?: string; note?: string };
    if (body.outcome !== 'accepted' && body.outcome !== 'rejected') {
      return errorJson(400, 'UNKNOWN_OUTCOME');
    }
    const note = typeof body.note === 'string' ? body.note : null;
    if (body.outcome === 'rejected' && (!note || note.trim().length === 0)) {
      return errorJson(400, 'REJECTION_NOTE_REQUIRED');
    }

    const status = data.status as ObligationStatus;
    const now = new Date();
    const review = { reviewerRole, reviewedBy: uid, reviewedAt: now, outcome: body.outcome, note };

    if (body.outcome === 'accepted') {
      try {
        assertLegalTransition(status, 'completed');
      } catch (err) {
        if (err instanceof IllegalTransitionError) return errorJson(409, 'NOT_UNDER_REVIEW');
        throw err;
      }
      await obligation.ref.update({
        status: 'completed',
        completedAt: now,
        completedVia: 'review',
        review,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await writeGovernanceAuditOrThrow({
        actorUid: uid,
        action: 'compliance.review_accepted',
        subjectType: 'compliance_obligation',
        subjectId: id,
        details: { reviewerRole },
      });
      return NextResponse.json({ ok: true, status: 'completed' });
    }

    // Rejected: back to 'due', dueDate untouched.
    try {
      assertLegalTransition(status, 'due');
    } catch (err) {
      if (err instanceof IllegalTransitionError) return errorJson(409, 'NOT_UNDER_REVIEW');
      throw err;
    }
    await obligation.ref.update({
      status: 'due',
      review,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.review_rejected',
      subjectType: 'compliance_obligation',
      subjectId: id,
      details: {
        reviewerRole,
        note,
        dueDate: tsToDate(data.dueDate)?.toISOString() ?? null,
      },
    });
    return NextResponse.json({ ok: true, status: 'due', dueDateUnchanged: true });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/obligations/review] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
