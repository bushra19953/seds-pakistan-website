/**
 * Cadetship checklist + evaluation agreement rules + read-time status
 * derivation (phase2_spec.md Sections F.3, F.4, F.5).
 *
 * Pure functions over plain doc data - client-safe, no Firestore access.
 * The confirmation route recomputes checklistComplete server-side from the
 * stored doc and never trusts a client-sent "complete" flag; the tracker UI
 * and admin roster use the same helpers so all three surfaces agree.
 */

import type {
  CadetshipDoc,
  CadetshipStatus,
  EvaluationDoc,
} from './types';

/** F.4 completion rule: the four tracked checklist items, all done. */
export function checklistComplete(
  doc: Pick<CadetshipDoc, 'items' | 'conduct'>,
): boolean {
  return (
    doc.items.orientation.done === true &&
    doc.items.workshops.count >= 2 &&
    doc.items.sprintTask.taskId != null &&
    doc.conduct.acknowledged === true
  );
}

/** Number of the four tracked items currently complete (0-4). */
export function checklistDoneCount(
  doc: Pick<CadetshipDoc, 'items' | 'conduct'>,
): number {
  let n = 0;
  if (doc.items.orientation.done) n += 1;
  if (doc.items.workshops.count >= 2) n += 1;
  if (doc.items.sprintTask.taskId != null) n += 1;
  if (doc.conduct.acknowledged) n += 1;
  return n;
}

export type EvaluationOutcome =
  | 'incomplete'
  | 'confirmable'
  | 'extendable'
  | 'exitable'
  | 'escalated';

/**
 * F.5 agreement rules. `evals` is the set of submitted evaluations (0, 1 or
 * 2). Round 2 has no extension: any 'extend' recommendation in round 2 makes
 * the outcome 'escalated' for the NMD to resolve, never 'extendable'.
 */
export function evaluationOutcome(
  evals: Pick<EvaluationDoc, 'recommendation'>[],
  round: 1 | 2,
): EvaluationOutcome {
  if (evals.length < 2) return 'incomplete';
  const recs = evals.slice(0, 2).map((e) => e.recommendation);
  const [a, b] = recs;
  if (a === b) {
    if (a === 'confirm') return 'confirmable';
    if (a === 'exit') return 'exitable';
    // both 'extend'
    return round === 1 ? 'extendable' : 'escalated';
  }
  return 'escalated';
}

export interface EffectiveStatus {
  status: CadetshipStatus;
  reviewDue: boolean;
}

/**
 * F.3 read-time derivation: a stored 'active' record whose probationEnd has
 * passed READS as under_review even if the cron stanza has not run yet (a
 * missed cron run never leaves a cadet visibly "in week 12 of 8"). A stored
 * 'extended' record past extendedTo stays 'extended' but reads reviewDue.
 */
export function cadetshipEffectiveStatus(
  doc: Pick<CadetshipDoc, 'status' | 'probationEnd' | 'extendedTo' | 'reviewDue'>,
  now: Date,
): EffectiveStatus {
  if (doc.status === 'active' && now.getTime() >= doc.probationEnd.getTime()) {
    return { status: 'under_review', reviewDue: true };
  }
  if (doc.status === 'extended') {
    const due =
      doc.reviewDue === true ||
      (doc.extendedTo != null && now.getTime() >= doc.extendedTo.getTime());
    return { status: 'extended', reviewDue: due };
  }
  if (doc.status === 'under_review') {
    return { status: 'under_review', reviewDue: true };
  }
  return { status: doc.status, reviewDue: false };
}

/** True when a decision route may fire for this record right now. */
export function isDecisionDue(
  doc: Pick<CadetshipDoc, 'status' | 'probationEnd' | 'extendedTo' | 'reviewDue'>,
  now: Date,
): boolean {
  const eff = cadetshipEffectiveStatus(doc, now);
  return eff.status === 'under_review' || (eff.status === 'extended' && eff.reviewDue);
}
