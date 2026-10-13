/**
 * silence-escalation.ts
 *
 * Pure escalation-ladder logic for assignee silence on tasks and workflows.
 *
 * Context: an assignee went quiet on Oct 10 and nobody noticed until the
 * Oct 12 deadline. This module turns "how long has this person been silent"
 * into an escalation level plus a recommended action, so a scheduler or cron
 * job can nudge and escalate before the deadline instead of discovering the
 * silence after it.
 *
 * No side effects: no Firestore, no network, no timers, no writes. Callers
 * pass timestamps in and get a plain result back. Delivery of the nudge or
 * alert (WhatsApp message, admin UI banner, reassignment) belongs to the
 * caller, not to this module.
 */

/** Milliseconds in one hour. */
export const HOUR_MS = 3600000;

/** Silence hours after which the assignee gets a nudge. */
export const NUDGE_AFTER_HOURS = 48;

/** Silence hours after which the task escalates to the team lead. */
export const ESCALATE_AFTER_HOURS = 96;

/** Silence hours that count as "silent" for the critical rung. */
export const CRITICAL_SILENCE_HOURS = 24;

/** Hours before the deadline at which a silent assignee becomes critical. */
export const CRITICAL_DEADLINE_WITHIN_HOURS = 24;

/** Escalation levels, ordered from least to most severe. */
export type EscalationLevel = 'none' | 'nudge' | 'escalate' | 'critical' | 'overdue';

/** Machine-readable recommended action for each escalation level. */
export type RecommendedAction =
  | 'no_action'
  | 'nudge_assignee'
  | 'escalate_to_team_lead'
  | 'critical_alert'
  | 'flag_overdue';

/**
 * One rung of the escalation ladder.
 *
 * A rung fires when the assignee's silence reaches `silenceHoursAtLeast` and,
 * when `deadlineHoursAtMost` is set, the time left until the deadline is at
 * most that many hours. The evaluator returns the most severe firing rung, so
 * ESCALATION_LADDER must stay ordered from most severe to least severe.
 */
export interface EscalationRung {
  level: Exclude<EscalationLevel, 'none'>;
  silenceHoursAtLeast: number;
  deadlineHoursAtMost?: number;
  action: RecommendedAction;
  headline: string;
  description: string;
}

/** Plain-language text for the "none" level. */
export const NO_ESCALATION_TEXT =
  'No escalation needed. The assignee has shown recent activity and the deadline is not close.';

/**
 * The escalation ladder as data, most severe first.
 *
 * - 48h of silence: nudge the assignee.
 * - 96h of silence: escalate to the team lead.
 * - Deadline within 24h while the assignee has been silent for 24h: critical.
 * - Deadline passed: overdue, regardless of silence.
 */
export const ESCALATION_LADDER: readonly EscalationRung[] = [
  {
    level: 'overdue',
    silenceHoursAtLeast: 0,
    deadlineHoursAtMost: 0,
    action: 'flag_overdue',
    headline: 'Overdue',
    description:
      'The deadline has passed. Flag the task, tell the team lead, and set a new deadline or reassign it.',
  },
  {
    level: 'critical',
    silenceHoursAtLeast: CRITICAL_SILENCE_HOURS,
    deadlineHoursAtMost: CRITICAL_DEADLINE_WITHIN_HOURS,
    action: 'critical_alert',
    headline: 'Critical: deadline within 24 hours and assignee silent',
    description:
      'The deadline is within 24 hours and the assignee has been silent for at least 24 hours. Alert the team lead and the chair now, and reassign the task if there is no reply.',
  },
  {
    level: 'escalate',
    silenceHoursAtLeast: ESCALATE_AFTER_HOURS,
    action: 'escalate_to_team_lead',
    headline: 'Escalate to team lead',
    description:
      'No activity for 96 hours and the nudge did not work. The team lead should step in to reassign the task or unblock it.',
  },
  {
    level: 'nudge',
    silenceHoursAtLeast: NUDGE_AFTER_HOURS,
    action: 'nudge_assignee',
    headline: 'Nudge assignee',
    description:
      'No activity for 48 hours. Send the assignee a short check-in asking for a status update.',
  },
];

/** Full result of evaluating one assignee's silence against the ladder. */
export interface SilenceEvaluation {
  level: EscalationLevel;
  action: RecommendedAction;
  headline: string;
  /** Plain-language text for the level, from describeEscalation. No em dashes. */
  description: string;
  /** The ladder rung that fired, or null when the level is "none". */
  rung: EscalationRung | null;
  /** Milliseconds since the assignee's last activity. */
  silenceMs: number;
  /** Hours since the assignee's last activity. */
  silenceHours: number;
  /** Hours left until the deadline, or Infinity when no usable deadline was given. */
  hoursToDeadline: number;
  /** True when the deadline has passed. */
  deadlinePassed: boolean;
}

/** Normalize an epoch-ms timestamp or Date into epoch ms. */
function toEpochMs(value: number | Date): number {
  return value instanceof Date ? value.getTime() : value;
}

/** True when the rung's trigger conditions hold for the given measurements. */
function rungFires(rung: EscalationRung, silenceHours: number, hoursToDeadline: number): boolean {
  if (silenceHours < rung.silenceHoursAtLeast) return false;
  if (rung.deadlineHoursAtMost !== undefined && hoursToDeadline > rung.deadlineHoursAtMost) {
    return false;
  }
  return true;
}

/**
 * Plain-language text for an escalation level. Safe to show in admin UI,
 * alerts, or message drafts. Contains no em dashes.
 */
export function describeEscalation(level: EscalationLevel): string {
  if (level === 'none') return NO_ESCALATION_TEXT;
  const rung = ESCALATION_LADDER.find((r) => r.level === level);
  return rung ? rung.description : NO_ESCALATION_TEXT;
}

/** True when the level calls for any action at all. */
export function isEscalated(level: EscalationLevel): boolean {
  return level !== 'none';
}

/**
 * Severity rank for a level: 0 for "none", higher for more severe.
 * Matches the existing convention where 0 means no escalation
 * (see `silenceEscalationLevel` in task-types.ts), and is handy for
 * sorting tasks by urgency or for storing the level as a number.
 */
export function escalationLevelRank(level: EscalationLevel): number {
  switch (level) {
    case 'none':
      return 0;
    case 'nudge':
      return 1;
    case 'escalate':
      return 2;
    case 'critical':
      return 3;
    case 'overdue':
      return 4;
  }
}

/**
 * Evaluate an assignee's silence against the escalation ladder.
 *
 * @param lastActivityAt - epoch ms (or Date) of the assignee's last recorded
 *   activity: a submission, comment, or status change, anything proving they
 *   are still on the task. A missing or invalid value is treated as "never
 *   active", so the task escalates instead of slipping through unnoticed.
 * @param deadlineMs - epoch ms (or Date) of the task deadline. A missing or
 *   invalid value means "no deadline": silence rungs can still fire, but the
 *   deadline-driven rungs (critical, overdue) cannot.
 * @param nowMs - epoch ms (or Date) for "now". Passed in explicitly so the
 *   function stays pure and testable. Must be a finite timestamp.
 * @throws RangeError when nowMs is not a finite timestamp.
 */
export function evaluateSilence(
  lastActivityAt: number | Date,
  deadlineMs: number | Date,
  nowMs: number | Date
): SilenceEvaluation {
  const now = toEpochMs(nowMs);
  if (!Number.isFinite(now)) {
    throw new RangeError('evaluateSilence: nowMs must be a finite timestamp.');
  }

  const last = toEpochMs(lastActivityAt);
  const deadline = toEpochMs(deadlineMs);

  // Unknown last activity means "never active": escalate rather than stay quiet.
  // MAX_SAFE_INTEGER keeps the value JSON-safe (unlike Infinity).
  const silenceMs = Number.isFinite(last) ? Math.max(0, now - last) : Number.MAX_SAFE_INTEGER;
  const silenceHours = silenceMs / HOUR_MS;

  const hasDeadline = Number.isFinite(deadline) && deadline > 0;
  const hoursToDeadline = hasDeadline ? (deadline - now) / HOUR_MS : Number.POSITIVE_INFINITY;
  const deadlinePassed = hasDeadline && hoursToDeadline <= 0;

  const rung = ESCALATION_LADDER.find((r) => rungFires(r, silenceHours, hoursToDeadline)) ?? null;
  const level: EscalationLevel = rung ? rung.level : 'none';

  return {
    level,
    action: rung ? rung.action : 'no_action',
    headline: rung ? rung.headline : 'No escalation',
    description: describeEscalation(level),
    rung,
    silenceMs,
    silenceHours,
    hoursToDeadline,
    deadlinePassed,
  };
}
