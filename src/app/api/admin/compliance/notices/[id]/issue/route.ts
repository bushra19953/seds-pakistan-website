/**
 * POST /api/admin/compliance/notices/[id]/issue (phase2_spec.md G.6).
 *
 * The Audit Chair - and ONLY the Audit Chair's current holder - issues a
 * default notice. The Founder cannot issue (his powers here are receipt
 * of a copy and, later, intervention). The holder is RE-RESOLVED at
 * issue: if the office changed hands since the draft, the notice issues
 * to the NEW holder and the previous holder is recorded as
 * priorHolderUid - the duty follows the office.
 *
 * cureDeadline = issuedAt + 7 days is STORED at issue and never
 * recomputed. Copies go to the Founder and the President with
 * per-recipient delivery receipts written back; a failed copy is left
 * ok:false for the cron's receipt-repair pass - "copy sent" is never
 * asserted without a receipt.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, isAuditChair, loadNotice, displayNameOf } from '@/lib/server/compliance/access';
import { resolveObligationRecipients, PRESIDENT_ROLE_KEY } from '@/lib/server/compliance/owner-resolution';
import { resolveRoleHolders } from '@/lib/server/compliance-role-holders';
import { assertLegalTransition } from '@/lib/server/compliance/transitions';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { notificationService } from '@/lib/server/notification-service';
import { FOUNDER_UID } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    if (!(await isAuditChair(uid))) return errorJson(403, 'FORBIDDEN');

    // Firestore store forced: notice.ref is used inside the issue
    // transaction below, which stays Firestore (plan ruling G2-1).
    const notice = await loadNotice(db, id, { store: 'firestore' });
    if (!notice) return errorJson(404, 'NOTICE_NOT_FOUND');
    if (notice.data.issuedAt != null) return errorJson(409, 'ALREADY_ISSUED');

    const obligationRef = db.collection('compliance_obligations').doc(notice.data.obligationId as string);
    const now = new Date();
    const cureDeadline = new Date(now.getTime() + 7 * DAY_MS);

    const issued = await db.runTransaction(async (tx) => {
      const obligationSnap = await tx.get(obligationRef);
      if (!obligationSnap.exists) throw new Error('OBLIGATION_MISSING');
      const obligation = obligationSnap.data() as Record<string, any>;
      if (obligation.status !== 'default_draft') throw new Error('NOT_IN_DEFAULT_DRAFT');

      // Re-resolve the holder AT ISSUE (G.6).
      const resolved = await resolveObligationRecipients(
        notice.data.officeRole as string,
        (obligation.chapterId as string | null) ?? null,
      );
      const issuedToUid = resolved.holderUid;
      const snapshotHolder = (obligation.ownerUidSnapshot as string | null) ?? null;
      const priorHolderUid =
        snapshotHolder && snapshotHolder !== issuedToUid ? snapshotHolder : null;

      assertLegalTransition('default_draft', 'default_issued');
      assertLegalTransition('default_issued', 'cure_period');
      tx.update(obligationRef, {
        status: 'cure_period',
        ownerUidSnapshot: issuedToUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(notice.ref, {
        issuedAt: now,
        issuedBy: uid,
        issuedToUid,
        issuedToName: await displayNameOf(db, issuedToUid),
        priorHolderUid,
        cureDeadline,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { issuedToUid, priorHolderUid };
    }).catch((err: Error) => {
      if (err.message === 'NOT_IN_DEFAULT_DRAFT') return null;
      throw err;
    });
    if (!issued) return errorJson(409, 'NOT_IN_DEFAULT_DRAFT');

    // Copies with receipts (post-commit; failures stay ok:false for the
    // cron's receipt-repair pass).
    const presidents = await resolveRoleHolders(PRESIDENT_ROLE_KEY);
    const copyPayload = {
      type: 'compliance_default_notice_copy',
      title: 'Default notice issued',
      body: `A default notice was issued for obligation ${notice.data.obligationId} (office: ${notice.data.officeRole}). Cure deadline: ${cureDeadline.toISOString().slice(0, 10)}.`,
      link: '/admin/compliance/notices',
    };
    async function sendCopy(targetUid: string | null): Promise<{ method: 'notification'; ref: string | null; at: Date; ok: boolean }> {
      if (!targetUid) return { method: 'notification', ref: null, at: now, ok: false };
      try {
        await notificationService.send(targetUid, copyPayload, 'P0');
        return { method: 'notification', ref: 'notificationService', at: now, ok: true };
      } catch {
        return { method: 'notification', ref: null, at: now, ok: false };
      }
    }
    const deliveryReceipts = {
      founder: await sendCopy(FOUNDER_UID),
      president: await sendCopy(presidents[0] ?? null),
    };
    await notice.ref.update({ deliveryReceipts, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.default_notice_issued',
      subjectType: 'default_notice',
      subjectId: id,
      details: {
        obligationId: notice.data.obligationId,
        issuedToUid: issued.issuedToUid,
        priorHolderUid: issued.priorHolderUid,
        cureDeadline: cureDeadline.toISOString(),
      },
    });

    return NextResponse.json({
      ok: true,
      issuedToUid: issued.issuedToUid,
      priorHolderUid: issued.priorHolderUid,
      cureDeadline: cureDeadline.toISOString(),
      deliveryReceipts: {
        founder: { ok: deliveryReceipts.founder.ok },
        president: { ok: deliveryReceipts.president.ok },
      },
    });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/notices/issue] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
