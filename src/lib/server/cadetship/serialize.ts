/**
 * Firestore -> plain-object conversion for cadetship docs (server side).
 * Stored dates are Firestore Timestamps; the pure helpers in
 * src/lib/cadetship/* work on Dates, so every server reader goes through
 * here exactly once.
 */

import type { CadetshipDoc, EvaluationDoc } from '@/lib/cadetship/types';

export function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  if (typeof value === 'number') return new Date(value);
  return null;
}

export function cadetshipFromFirestore(id: string, raw: Record<string, any>): CadetshipDoc {
  return {
    id,
    personUid: raw.personUid,
    applicationId: raw.applicationId,
    cohortId: raw.cohortId,
    chapterId: raw.chapterId,
    createdVia: raw.createdVia,
    status: raw.status,
    startedAt: asDate(raw.startedAt) ?? new Date(0),
    probationEnd: asDate(raw.probationEnd) ?? new Date(0),
    extendedTo: asDate(raw.extendedTo),
    extensionUsed: raw.extensionUsed === true,
    reviewDue: raw.reviewDue === true,
    items: raw.items,
    conduct: raw.conduct,
    duesGate: raw.duesGate,
    decision: raw.decision,
    membershipClassWritePending: raw.membershipClassWritePending === true,
    evaluationReminderSentAt: asDate(raw.evaluationReminderSentAt),
    createdAt: asDate(raw.createdAt) ?? new Date(0),
    updatedAt: asDate(raw.updatedAt) ?? new Date(0),
    updatedBy: raw.updatedBy,
  };
}

export function evaluationFromFirestore(raw: Record<string, any>): EvaluationDoc {
  return {
    evaluatorUid: raw.evaluatorUid,
    evaluatorRoleKey: raw.evaluatorRoleKey,
    evaluatorChapterId: raw.evaluatorChapterId ?? null,
    recommendation: raw.recommendation,
    note: raw.note,
    submittedAt: asDate(raw.submittedAt) ?? new Date(0),
    revisedAt: asDate(raw.revisedAt),
    singleEvaluatorReason: raw.singleEvaluatorReason ?? null,
  };
}

/** API-safe view of a cadetship: Dates as ISO strings. */
export function cadetshipToJson(doc: CadetshipDoc): Record<string, unknown> {
  return {
    ...doc,
    startedAt: doc.startedAt.toISOString(),
    probationEnd: doc.probationEnd.toISOString(),
    extendedTo: doc.extendedTo ? doc.extendedTo.toISOString() : null,
    evaluationReminderSentAt: doc.evaluationReminderSentAt
      ? doc.evaluationReminderSentAt.toISOString()
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    decision: {
      ...doc.decision,
      decidedAt: doc.decision.decidedAt ? doc.decision.decidedAt.toISOString() : null,
    },
  };
}
