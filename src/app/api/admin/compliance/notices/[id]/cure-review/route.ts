/**
 * POST /api/admin/compliance/notices/[id]/cure-review (phase2_spec.md G.6).
 *
 * Audit Chair only. Accept: the notice is 'cured' and the instance
 * completes via 'cure'. Reject: the cure is marked rejected and the
 * cure clock does NOT restart - cureDeadline stands (Calendar sec. 3.2
 * gives 7 days to cure, not 7 days per attempt).
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isAuditChair, loadNotice, loadObligation } from '@/lib/server/compliance/access';
import { assertLegalTransition } from '@/lib/server/compliance/transitions';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { tsToDate } from '@/lib/server/compliance/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    if (!(await isAuditChair(uid))) return errorJson(403, 'FORBIDDEN');

    const notice = await loadNotice(db, id);
    if (!notice) return errorJson(404, 'NOTICE_NOT_FOUND');
    if (!notice.data.cure) return errorJson(409, 'NO_CURE_SUBMITTED');
    if (notice.data.cureReview) return errorJson(409, 'CURE_ALREADY_REVIEWED');

    const body = (await req.json().catch(() => ({}))) as { outcome?: string; note?: string };
    if (body.outcome !== 'accepted' && body.outcome !== 'rejected') {
      return errorJson(400, 'UNKNOWN_OUTCOME');
    }

    const now = new Date();
    const cureReview = {
      reviewedBy: uid,
      reviewedAt: now,
      outcome: body.outcome,
      note: typeof body.note === 'string' ? body.note : null,
    };

    if (body.outcome === 'rejected') {
      await notice.ref.update({
        cureReview,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await writeGovernanceAuditOrThrow({
        actorUid: uid,
        action: 'compliance.cure_rejected',
        subjectType: 'default_notice',
        subjectId: id,
        details: {
          obligationId: notice.data.obligationId,
          // The deadline stands - stated in the audit so no one can later
          // claim a rejection restarted the clock.
          cureDeadline: tsToDate(notice.data.cureDeadline)?.toISOString() ?? null,
        },
      });
      return NextResponse.json({ ok: true, outcome: 'rejected', cureDeadlineUnchanged: true });
    }

    const obligation = await loadObligation(db, notice.data.obligationId as string);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    assertLegalTransition(obligation.data.status, 'completed');
    await obligation.ref.update({
      status: 'completed',
      completedAt: now,
      completedVia: 'cure',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await notice.ref.update({
      cureReview,
      outcome: 'cured',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.cure_accepted',
      subjectType: 'default_notice',
      subjectId: id,
      details: { obligationId: notice.data.obligationId },
    });
    return NextResponse.json({ ok: true, outcome: 'cured', obligationStatus: 'completed' });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/notices/cure-review] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
