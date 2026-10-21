/**
 * POST /api/admin/compliance/obligations/[id]/cure (phase2_spec.md G.6).
 *
 * The CURRENT office holder submits cure evidence against an issued
 * default notice. The instance stays in cure_period pending the Audit
 * Chair's cure review - submission alone cures nothing. A resubmission
 * (after a rejection) replaces the cure and clears the prior review, so
 * the new cure is the pending one; the cureDeadline never moves.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, loadObligation, loadNotice } from '@/lib/server/compliance/access';
import { resolveObligationRecipients } from '@/lib/server/compliance/owner-resolution';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const obligation = await loadObligation(db, id);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    if (obligation.data.status !== 'cure_period') return errorJson(409, 'NOT_IN_CURE_PERIOD');

    // Holder resolved live: only the current holder may cure.
    const resolved = await resolveObligationRecipients(
      obligation.data.officeRole as string,
      (obligation.data.chapterId as string | null) ?? null,
    );
    if (resolved.holderUid !== uid) return errorJson(403, 'FORBIDDEN');

    const noticeId = obligation.data.defaultNoticeId as string | null;
    if (!noticeId) return errorJson(409, 'NO_DEFAULT_NOTICE');
    const notice = await loadNotice(db, noticeId);
    if (!notice) return errorJson(404, 'NOTICE_NOT_FOUND');

    const body = (await req.json().catch(() => ({}))) as { evidenceRef?: string; note?: string };
    const evidenceRef = typeof body.evidenceRef === 'string' ? body.evidenceRef.trim() : '';
    if (!evidenceRef) return errorJson(400, 'EVIDENCE_REF_REQUIRED');

    const now = new Date();
    await notice.ref.update({
      cure: {
        submittedBy: uid,
        submittedAt: now,
        evidenceRef,
        note: typeof body.note === 'string' ? body.note : null,
      },
      cureReview: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.cure_submitted',
      subjectType: 'default_notice',
      subjectId: noticeId,
      details: { obligationId: id, evidenceRef },
    });
    return NextResponse.json({ ok: true, noticeId, cureSubmittedAt: now.toISOString() });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/obligations/cure] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
