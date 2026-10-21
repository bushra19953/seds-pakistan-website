/**
 * POST /api/admin/compliance/triggers (phase2_spec.md Section G.8).
 *
 * Records an event trigger and creates its instance in the same request.
 * Callers: NGS holders, Audit Chair holders, plus the template's
 * alsoRecordableBy role holders - enforced server-side from the template
 * doc. The office holder is notified AT TRIGGER TIME (the duty exists
 * now, not at the first ladder rung).
 *
 * Duplicate idempotencyKey -> 200 with the existing obligationId: never
 * a second instance, never an error. An event instance without a trigger
 * doc cannot be created anywhere (this route is the only path).
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { dbOrThrow, callerRoleKey } from '@/lib/server/compliance/access';
import { resolveObligationRecipients } from '@/lib/server/compliance/owner-resolution';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { notificationService } from '@/lib/server/notification-service';
import { AUDIT_CHAIR_ROLE, NGS_ROLE_KEY } from '@/lib/server/compliance/access';
import type { DeadlineRule } from '@/lib/compliance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DAY_MS = 24 * 60 * 60 * 1000;

function computeDueDate(
  rule: DeadlineRule,
  triggerDate: Date,
  subjectDate: Date | null,
): Date | null {
  if (rule.kind === 'days_after_trigger') {
    return new Date(triggerDate.getTime() + rule.days * DAY_MS);
  }
  if (rule.kind === 'days_before_subject_date') {
    if (!subjectDate) return null;
    return new Date(subjectDate.getTime() - rule.days * DAY_MS);
  }
  if (rule.kind === 'prior_to_execution') {
    // G.3: due = the execution (subject) date; the reminder ladder does
    // the "prior" work. Modelled approximation, flagged in the seed data.
    return subjectDate;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();

    const body = (await req.json().catch(() => ({}))) as {
      templateKey?: string;
      triggerType?: string;
      triggerDate?: string;
      subjectDate?: string;
      subjectRef?: { kind?: string; id?: string; label?: string };
      idempotencyKey?: string;
      note?: string;
    };
    const templateKey = typeof body.templateKey === 'string' ? body.templateKey : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!templateKey) return errorJson(400, 'TEMPLATE_KEY_REQUIRED');
    if (!idempotencyKey) return errorJson(400, 'IDEMPOTENCY_KEY_REQUIRED');

    // Idempotency first: a duplicate returns the original outcome.
    const existing = await db
      .collection('compliance_triggers')
      .where('idempotencyKey', '==', idempotencyKey)
      .limit(1)
      .get();
    if (!existing.empty) {
      const trigger = existing.docs[0].data() as Record<string, any>;
      return NextResponse.json({
        ok: true,
        duplicate: true,
        triggerId: existing.docs[0].id,
        obligationId: trigger.obligationId ?? null,
      });
    }

    const templateSnap = await db.collection('compliance_templates').doc(templateKey).get();
    if (!templateSnap.exists) return errorJson(404, 'TEMPLATE_NOT_FOUND');
    const template = templateSnap.data() as Record<string, any>;
    if (template.cadence !== 'event') return errorJson(400, 'NOT_EVENT_TEMPLATE');

    // Caller gate: NGS, Audit Chair, or a template alsoRecordableBy holder.
    const roleKey = await callerRoleKey(uid);
    const alsoRecordableBy: string[] = Array.isArray(template.alsoRecordableBy)
      ? template.alsoRecordableBy
      : [];
    const allowed =
      roleKey === NGS_ROLE_KEY ||
      roleKey === AUDIT_CHAIR_ROLE ||
      (roleKey != null && alsoRecordableBy.includes(roleKey));
    if (!allowed) return errorJson(403, 'FORBIDDEN');

    const triggerDate = body.triggerDate ? new Date(body.triggerDate) : new Date();
    if (Number.isNaN(triggerDate.getTime())) return errorJson(400, 'INVALID_TRIGGER_DATE');
    const subjectDate = body.subjectDate ? new Date(body.subjectDate) : null;
    if (subjectDate && Number.isNaN(subjectDate.getTime())) {
      return errorJson(400, 'INVALID_SUBJECT_DATE');
    }
    const dueDate = computeDueDate(template.deadlineRule as DeadlineRule, triggerDate, subjectDate);
    if (!dueDate) return errorJson(400, 'SUBJECT_DATE_REQUIRED');

    const stamp = () => admin.firestore.FieldValue.serverTimestamp();
    const triggerRef = db.collection('compliance_triggers').doc();
    const obligationId = `${templateKey}__evt__${triggerRef.id}`;
    const obligationRef = db.collection('compliance_obligations').doc(obligationId);

    await triggerRef.set({
      templateKey,
      triggerType: typeof body.triggerType === 'string' ? body.triggerType : 'event',
      triggerDate: admin.firestore.Timestamp.fromDate(triggerDate),
      subjectRef: {
        kind: typeof body.subjectRef?.kind === 'string' ? body.subjectRef.kind : 'event',
        id: typeof body.subjectRef?.id === 'string' ? body.subjectRef.id : '',
        label: typeof body.subjectRef?.label === 'string' ? body.subjectRef.label : '',
      },
      recordedBy: uid,
      recordedAt: stamp(),
      idempotencyKey,
      obligationId,
      note: typeof body.note === 'string' ? body.note : null,
    });

    await obligationRef.set({
      instanceKey: obligationId,
      templateKey,
      templateVersion: template.templateVersion ?? 1,
      title: template.title,
      officeRole: template.officeRole,
      ownerUidSnapshot: null,
      chapterId: null,
      periodKey: 'event',
      periodLabel: 'Event',
      dueDate: admin.firestore.Timestamp.fromDate(dueDate),
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
      createdBy: 'trigger',
      seedHold: false,
      triggerId: triggerRef.id,
      createdAt: stamp(),
      updatedAt: stamp(),
    });

    // The holder is notified at trigger time (G.8).
    const resolved = await resolveObligationRecipients(template.officeRole as string, null);
    for (const recipient of resolved.recipients) {
      try {
        await notificationService.send(
          recipient,
          {
            type: 'compliance_trigger',
            title: `New compliance duty: ${template.title}`,
            body: `${template.title} was recorded and is due ${dueDate.toISOString().slice(0, 10)} (office: ${template.officeRole}).`,
            link: `/admin/compliance/obligations/${obligationId}`,
          },
          'P0',
        );
      } catch {
        // The duty is recorded regardless; the ladder will remind.
      }
    }

    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.trigger_recorded',
      subjectType: 'compliance_trigger',
      subjectId: triggerRef.id,
      details: { templateKey, obligationId, dueDate: dueDate.toISOString(), idempotencyKey },
    });

    return NextResponse.json({
      ok: true,
      triggerId: triggerRef.id,
      obligationId,
      dueDate: dueDate.toISOString(),
      holderNotified: resolved.recipients,
    });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/triggers] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
