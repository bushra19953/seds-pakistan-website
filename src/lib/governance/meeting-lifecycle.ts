/**
 * Meeting lifecycle state machine + 30-minute auto-adjourn evaluator.
 *
 * Phase 3, Workstream A, worker 5 slice (meeting lifecycle + auto-adjourn
 * timer). Pure logic only: no Firebase, no Next, no I/O. All times are epoch
 * milliseconds (the server layer converts Firestore Timestamps at its edge).
 *
 * Sources (read for this slice only):
 * - phase3_spec.md Part A, section 6.1 (meeting status state machine),
 *   section 6.6 item T1 (auto-adjourn timer), section 3.3 (meeting fields).
 * - drafts/ws-a.md sections 6.1 / 6.6 (same text).
 *
 * Status names follow the spec exactly (section 3.3 / 6.1):
 *   draft | noticed | convened | adjourned | reconvened | closed | cancelled
 * (The brief's colloquial scheduled -> notice_sent -> in_session -> concluded
 * maps onto noticed -> convened -> closed; spec names win.)
 *
 * The 30-minute rule: a timer runs from the scheduled start (scheduledAt).
 * If quorum has not been achieved by scheduledAt + 30 minutes, the meeting
 * auto-adjourns. "Quorum achieved" means the chair has verified it
 * (quorumVerifiedAt set, status convened) OR the live quorum evaluation at
 * decision time reports met. The reconvene is a NEW meeting doc of type
 * 'adjourned', status 'noticed', parentMeetingId pointing back (section 6.1):
 * - Board: quorumRequired 3 with founderPresenceRequired (reduced rule).
 * - Other bodies: quorumRequired copied, scheduledAt is the same weekday
 *   and time the following week (+7 days, P-05).
 * - Board reconvene date: section 6.1 specifies no separate date rule for
 *   the Board, so the same +7 days same-time default is applied and the
 *   plan flags it via `rule` so a later ruling can change one place.
 */

import type { QuorumEvaluation } from './quorum-adapter';

export const MEETING_STATUSES = [
  'draft',
  'noticed',
  'convened',
  'adjourned',
  'reconvened',
  'closed',
  'cancelled',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_TYPES = [
  'ordinary',
  'emergency',
  'adjourned',
  'agm',
  'special',
] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

/** The auto-adjourn grace period: 30 minutes from scheduled start. */
export const AUTO_ADJOURN_AFTER_MS = 30 * 60 * 1000;

/** Reduced quorum for an adjourned Board sitting (spec 6.1 / 6.2). */
export const BOARD_ADJOURNED_QUORUM = 3;

/** Reconvene offset for non-Board bodies: same time next week (P-05). */
export const RECONVENE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Allowed transitions (spec 6.1). 'closed' and 'cancelled' are terminal.
 * Any pre-close status may be cancelled by the chair or convenor.
 * 'adjourned' -> 'reconvened' is listed for implementations that flip the
 * reconvene doc's status when it sits; in this build the reconvene is a new
 * doc created in 'noticed', and the original sitting stays 'adjourned'.
 */
export const MEETING_TRANSITIONS: Readonly<Record<MeetingStatus, readonly MeetingStatus[]>> = {
  draft: ['noticed', 'cancelled'],
  noticed: ['convened', 'adjourned', 'cancelled'],
  convened: ['closed', 'cancelled'],
  adjourned: ['reconvened'],
  reconvened: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

export function isMeetingStatus(value: unknown): value is MeetingStatus {
  return typeof value === 'string' && (MEETING_STATUSES as readonly string[]).includes(value);
}

export function canTransitionMeeting(from: MeetingStatus, to: MeetingStatus): boolean {
  return MEETING_TRANSITIONS[from]?.includes(to) ?? false;
}

export class MeetingTransitionError extends Error {
  code = 'invalid_transition' as const;
  constructor(
    public from: string,
    public to: string,
  ) {
    super(`Invalid meeting status transition: ${from} -> ${to}`);
    this.name = 'MeetingTransitionError';
  }
}

export function assertMeetingTransition(from: MeetingStatus, to: MeetingStatus): void {
  if (!canTransitionMeeting(from, to)) throw new MeetingTransitionError(from, to);
}

export function isTerminalMeetingStatus(status: MeetingStatus): boolean {
  return status === 'closed' || status === 'cancelled';
}

/** Minimal meeting shape the pure evaluator needs (spec 3.3 subset). */
export interface MeetingLike {
  id: string;
  bodyId: string;
  bodyType: string;
  type: string;
  status: string;
  /** Epoch ms of the scheduled start. */
  scheduledAt: number;
  /** Stored at notice time (spec 3.3); never recomputed from a live body. */
  quorumRequired: number;
  /** Epoch ms when the chair verified quorum, or null. */
  quorumVerifiedAt: number | null;
  /** Set on the original once its reconvene doc exists (idempotency guard). */
  reconveneMeetingId?: string | null;
  parentMeetingId?: string | null;
}

export interface ReconvenePlan {
  /** Always 'adjourned': a derived type set only by the adjournment flow. */
  type: 'adjourned';
  /** The reconvene doc starts life as 'noticed' (spec 6.1). */
  status: 'noticed';
  parentMeetingId: string;
  scheduledAt: number;
  quorumRequired: number;
  /** Board adjourned sittings require the Founder present (spec 6.1/6.2). */
  founderPresenceRequired: boolean;
  rule: 'board_adjourned_reduced_quorum' | 'same_time_next_week';
  /** Adjourned meetings inherit the original notice; reminder email only. */
  inheritsNotice: true;
}

export function buildReconvenePlan(meeting: MeetingLike): ReconvenePlan {
  const isBoard = meeting.bodyType === 'board';
  return {
    type: 'adjourned',
    status: 'noticed',
    parentMeetingId: meeting.id,
    // Section 6.1 gives the explicit +7d same-time rule for non-Board
    // bodies and no separate Board date; the same default is applied to
    // the Board so the reconvene doc always carries a concrete time.
    scheduledAt: meeting.scheduledAt + RECONVENE_AFTER_MS,
    quorumRequired: isBoard ? BOARD_ADJOURNED_QUORUM : meeting.quorumRequired,
    founderPresenceRequired: isBoard,
    rule: isBoard ? 'board_adjourned_reduced_quorum' : 'same_time_next_week',
    inheritsNotice: true,
  };
}

export type AutoAdjournReason =
  | 'not_a_noticed_meeting'
  | 'quorum_already_verified'
  | 'quorum_met'
  | 'within_grace_period'
  | 'already_reconvened'
  | 'quorum_not_met_at_deadline';

export type AutoAdjournDecision =
  | { action: 'none'; reason: Exclude<AutoAdjournReason, 'quorum_not_met_at_deadline'>; deadlineAt: number }
  | {
      action: 'adjourn';
      reason: 'quorum_not_met_at_deadline';
      deadlineAt: number;
      reconvene: ReconvenePlan;
    };

/**
 * The pure 30-minute evaluator. Given the meeting, a quorum evaluation for
 * the CURRENT attendance (produced via the quorum adapter by the caller),
 * and `now`, decide whether the auto-adjourn fires.
 *
 * Boundary semantics: at exactly scheduledAt + 30:00 the grace period has
 * expired, so an unmet quorum adjourns; quorum met at minute 29 (or any
 * time the evaluation reports met / verification is recorded) never
 * adjourns, even when evaluated after the deadline.
 */
export function evaluateAutoAdjourn(input: {
  meeting: MeetingLike;
  quorum: QuorumEvaluation | null;
  now: number;
}): AutoAdjournDecision {
  const { meeting, quorum, now } = input;
  const deadlineAt = meeting.scheduledAt + AUTO_ADJOURN_AFTER_MS;

  if (meeting.status !== 'noticed') {
    return { action: 'none', reason: 'not_a_noticed_meeting', deadlineAt };
  }
  if (meeting.reconveneMeetingId) {
    return { action: 'none', reason: 'already_reconvened', deadlineAt };
  }
  if (meeting.quorumVerifiedAt !== null && meeting.quorumVerifiedAt !== undefined) {
    return { action: 'none', reason: 'quorum_already_verified', deadlineAt };
  }
  if (quorum?.met) {
    return { action: 'none', reason: 'quorum_met', deadlineAt };
  }
  if (now < deadlineAt) {
    return { action: 'none', reason: 'within_grace_period', deadlineAt };
  }
  return {
    action: 'adjourn',
    reason: 'quorum_not_met_at_deadline',
    deadlineAt,
    reconvene: buildReconvenePlan(meeting),
  };
}

/** Convenience deadline check mirroring the cron's T1 selection rule. */
export function isAutoAdjournCandidate(meeting: MeetingLike, now: number): boolean {
  return (
    meeting.status === 'noticed' &&
    !meeting.quorumVerifiedAt &&
    !meeting.reconveneMeetingId &&
    now >= meeting.scheduledAt + AUTO_ADJOURN_AFTER_MS
  );
}
