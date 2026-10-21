/**
 * Obligation state machine (phase2_spec.md Section G.4).
 *
 * The reminded_* states are ladder position markers, not gates. Terminal
 * states: completed, waived (escalated is NOT terminal - a Founder
 * intervention closes it into completed). Every transition is audit-logged
 * by its caller via writeGovernanceAuditOrThrow.
 */

import type { ObligationStatus } from '@/lib/compliance/types';

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ObligationStatus,
    public readonly to: ObligationStatus,
  ) {
    super(`Illegal compliance transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

const NON_TERMINAL: ObligationStatus[] = [
  'scheduled',
  'reminded_30',
  'reminded_14',
  'reminded_7',
  'due',
  'evidence_submitted',
  'under_review',
  'overdue',
  'default_draft',
  'default_issued',
  'cure_period',
  'escalated',
];

/** Legal transitions per G.4. Waiver is legal from every non-terminal state. */
export const LEGAL_TRANSITIONS: Record<ObligationStatus, ObligationStatus[]> = {
  scheduled: ['reminded_30', 'reminded_14', 'reminded_7', 'due', 'evidence_submitted', 'waived'],
  reminded_30: ['reminded_14', 'reminded_7', 'due', 'evidence_submitted', 'waived'],
  reminded_14: ['reminded_7', 'due', 'evidence_submitted', 'waived'],
  reminded_7: ['due', 'evidence_submitted', 'waived'],
  due: ['evidence_submitted', 'overdue', 'waived'],
  evidence_submitted: ['under_review', 'waived'],
  under_review: ['completed', 'due', 'waived'],
  completed: [],
  overdue: ['default_draft', 'waived'],
  default_draft: ['default_issued', 'waived'],
  default_issued: ['cure_period', 'waived'],
  cure_period: ['completed', 'escalated', 'waived'],
  escalated: ['completed', 'waived'],
  waived: [],
};

export function isLegalTransition(from: ObligationStatus, to: ObligationStatus): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

export function assertLegalTransition(from: ObligationStatus, to: ObligationStatus): void {
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isNonTerminal(status: ObligationStatus): boolean {
  return NON_TERMINAL.includes(status);
}

/**
 * The ladder state the dates say an instance should be in (G.4): the pass
 * computes position from dates rather than insisting on visiting each
 * rung. Only meaningful for instances in a ladder state; returns the
 * furthest rung reached by `now` (reminders fire per offset, at most
 * once, tracked by remindersSent).
 */
export function ladderStateFor(
  dueDate: Date,
  reminderOffsetsDays: number[],
  now: Date,
): 'scheduled' | 'reminded_30' | 'reminded_14' | 'reminded_7' | 'due' {
  if (now.getTime() >= dueDate.getTime()) return 'due';
  const daysUntil = Math.floor((dueDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const reached = reminderOffsetsDays
    .filter((offset) => daysUntil <= offset)
    .sort((a, b) => a - b)[0];
  if (reached === undefined) return 'scheduled';
  if (reached >= 30) return 'reminded_30';
  if (reached >= 14) return 'reminded_14';
  return 'reminded_7';
}
