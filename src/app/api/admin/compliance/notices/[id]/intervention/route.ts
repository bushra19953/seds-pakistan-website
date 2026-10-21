/**
 * POST /api/admin/compliance/notices/[id]/intervention (phase2_spec.md
 * G.4/G.6). Founder ONLY, and only after escalation.
 *
 *   performed_directly -> the instance completes via
 *     'founder_intervention'.
 *   interim_appointed  -> the instance completes as superseded AND a
 *     fresh instance is created for the interim holder with the
 *     Founder-supplied newDueDate (required - recorded, never silently
 *     defaulted).
 *   officer_removed    -> the instance STAYS escalated as the historical
 *     record; escalation.level becomes 'founder_intervention' and the
 *     vacancy itself is Workstream D's to derive.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, loadNotice, loadObligation } from '@/lib/server/compliance/access';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { isFounderUid } from '@/lib/server/founder-gate';
import { tsToDate } from '@/lib/server/compliance/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TYPES = ['performed_directly', 'interim_appointed', 'officer_removed'] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    if (!isFounderUid(uid)) return errorJson(403, 'FORBIDDEN');

    const notice = await loadNotice(db, id);
    if (!notice) return errorJson(404, 'NOTICE_NOT_FOUND');
    if (notice.data.outcome !== 'escalated') return errorJson(409, 'NOT_ESCALATED');

    const obligation = await loadObligation(db, notice.data.obligationId as string);
    if (!obligation) return errorJson(404, 'OBLIGATION_NOT_FOUND');
    if (obligation.data.status !== 'escalated') return errorJson(409, 'NOT_ESCALATED');

    const body = (await req.json().catch(() => ({}))) as {
      type?: string;
      note?: string;
      newDueDate?: string;
    };
    if (!TYPES.includes(body.type as (typeof TYPES)[number])) {
      return errorJson(400, 'UNKNOWN_INTERVENTION_TYPE');
    }
    const note = typeof body.note === 'string' ? body.note : null;
    const now = new Date();
    const stamp = () => admin.firestore.FieldValue.serverTimestamp();

    let newObligationId: string | null = null;

    if (body.type === 'performed_directly') {
      await obligation.ref.update({
        status: 'completed',
        completedAt: now,
        completedVia: 'founder_intervention',
        escalation: { level: 'founder_intervention', at: now, note },
        updatedAt: stamp(),
      });
    } else if (body.type === 'interim_appointed') {
      const newDueDate = body.newDueDate ? new Date(body.newDueDate) : null;
      if (!newDueDate || Number.isNaN(newDueDate.getTime())) {
        return errorJson(400, 'NEW_DUE_DATE_REQUIRED');
      }
      const freshRef = db
        .collection('compliance_obligations')
        .doc(`${obligation.data.templateKey}__evt__intervention-${id}`);
      await freshRef.set({
        instanceKey: freshRef.id,
        templateKey: obligation.data.templateKey,
        templateVersion: obligation.data.templateVersion ?? 1,
        title: obligation.data.title,
        officeRole: obligation.data.officeRole,
        ownerUidSnapshot: null,
        chapterId: obligation.data.chapterId ?? null,
        periodKey: 'interim',
        periodLabel: 'Interim appointment',
        dueDate: admin.firestore.Timestamp.fromDate(newDueDate),
        status: 'scheduled',
        evidence: null,
        review: null,
        waiver: null,
        remindersSent: { d30: null, d14: null, d7: null },
        reminderReceipts: [],
        overdueNotifiedAt: null,
        defaultNoticeId: null,
        escalation: { level: 'none', at: null, note: null },
        completedAt: null,
        completedVia: null,
        createdBy: 'manual',
        seedHold: false,
        triggerId: null,
        createdAt: stamp(),
        updatedAt: stamp(),
      });
      newObligationId = freshRef.id;
      await obligation.ref.update({
        status: 'completed',
        completedAt: now,
        completedVia: 'superseded',
        escalation: { level: 'founder_intervention', at: now, note },
        updatedAt: stamp(),
      });
    } else {
      // officer_removed: the instance stays escalated as the record.
      await obligation.ref.update({
        escalation: { level: 'founder_intervention', at: now, note },
        updatedAt: stamp(),
      });
    }

    await notice.ref.update({
      intervention: { type: body.type, byUid: uid, at: now, note, newObligationId },
      updatedAt: stamp(),
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.founder_intervention',
      subjectType: 'default_notice',
      subjectId: id,
      details: {
        obligationId: notice.data.obligationId,
        type: body.type,
        newObligationId,
        previousDueDate: tsToDate(obligation.data.dueDate)?.toISOString() ?? null,
      },
    });
    return NextResponse.json({ ok: true, type: body.type, newObligationId });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/notices/intervention] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
