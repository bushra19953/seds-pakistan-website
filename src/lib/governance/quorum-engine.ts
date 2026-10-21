/**
 * THE shared quorum and threshold engine for Phase 3 Part A.
 *
 * Pure functions only: no Firestore, no I/O, no imports beyond the shared
 * governance types. Callers (meetings, motions, circular resolutions,
 * reversals, overrides, ratifications) pass plain data in and apply the
 * returned reports themselves — this module never mutates its inputs and
 * never mutates motions; it reports state.
 *
 * This is the ONLY file allowed to contain quorum or threshold arithmetic.
 * A second implementation anywhere in the workstream is a review blocker.
 *
 * Rules implemented (Doc 04 secs 4.3-4.6, P-05, P-07; phase3_spec Part A 6.2):
 * - Electronic attendance counts IDENTICALLY to in person; absent never counts.
 * - Board ordinary quorum is 5. Board ADJOURNED quorum is 3 AND the Founder
 *   must be present. Every other body reads its quorum from the body config
 *   passed in (stored quorumRequired, else quorumOverride, else
 *   ceil(memberUids.length / 2)).
 * - No motion may open until the chair has verified quorum (verifyQuorum /
 *   canOpenMotion).
 * - Quorum is recomputed on every join and leave. If quorum drops
 *   mid-meeting, OPEN motions pause and CLOSED motions stand
 *   (applyQuorumToMotions reports; it does not mutate).
 * - A motion's denominator is snapshotted at open and never retaken
 *   (snapshotDenominator returns defensive copies).
 * - Ordinary majority: votesFor > votesAgainst among present-and-voting;
 *   abstentions are reported but never enter the comparison.
 * - Supermajority (fraction) classes: the fraction of the WHOLE snapshot
 *   (all Governors / all Full Members / all representatives), computed at open.
 * - A tie on an ordinary motion at Board or Council opens exactly ONE Founder
 *   casting ballot, recorded SEPARATELY from the ordinary votes.
 * - No recusal: nothing here blocks, excludes, or auto-abstains any voter.
 */

import type {
  AttendanceRecord,
  BallotChoice,
  BallotRecord,
  BodyConfigView,
  BodyType,
  CastingBallotRecord,
  DecisionClassView,
  DenominatorSnapshot,
  MotionQuorumEffect,
  MotionQuorumView,
  MotionThreshold,
  QuorumEvaluation,
  ThresholdEvaluation,
  VoteTallies,
} from './types';

/** Board of Governors ordinary-sitting quorum (Doc 04 sec 4.3). */
export const BOARD_ORDINARY_QUORUM = 5;

/** Board of Governors adjourned-sitting quorum; ALSO requires the Founder present. */
export const BOARD_ADJOURNED_QUORUM = 3;

/** Body types where a tie opens a Founder casting ballot (Doc 04 sec 4.6). */
export const CASTING_VOTE_BODY_TYPES: readonly BodyType[] = ['board', 'council'];

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Whether one attendance record counts as present right now.
 * Electronic == in person. A stored `isPresent` flag wins; otherwise presence
 * is derived: mode is not absent AND the member has not left (leftAt null).
 */
export function isPresent(record: AttendanceRecord): boolean {
  if (typeof record.isPresent === 'boolean') return record.isPresent;
  return record.mode !== 'absent' && (record.leftAt === null || record.leftAt === undefined);
}

/** Count of present attendees. Electronic counts identically to in person. */
export function computePresent(attendance: readonly AttendanceRecord[]): number {
  return attendance.reduce((count, record) => count + (isPresent(record) ? 1 : 0), 0);
}

/** Uids of present attendees, in attendance order. */
export function computePresentUids(attendance: readonly AttendanceRecord[]): string[] {
  return attendance.filter(isPresent).map((record) => record.uid);
}

/** Whether the Founder is among the present attendees (isFounder snapshot flag). */
export function isFounderPresent(attendance: readonly AttendanceRecord[]): boolean {
  return attendance.some((record) => record.isFounder === true && isPresent(record));
}

// ---------------------------------------------------------------------------
// Quorum
// ---------------------------------------------------------------------------

/**
 * The quorum number for a sitting, from the body config passed in.
 * Board adjourned: always 3 (the Founder condition is separate). Board
 * ordinary: stored quorumRequired / quorumOverride, else 5. Other bodies:
 * stored quorumRequired, else quorumOverride, else ceil(members / 2).
 */
export function resolveQuorumRequired(body: BodyConfigView): number {
  if (body.bodyType === 'board' && body.isAdjournedSitting) {
    return BOARD_ADJOURNED_QUORUM;
  }
  if (typeof body.quorumRequired === 'number') return body.quorumRequired;
  if (typeof body.quorumOverride === 'number') return body.quorumOverride;
  if (body.bodyType === 'board') return BOARD_ORDINARY_QUORUM;
  return Math.ceil(body.memberUids.length / 2);
}

/**
 * Evaluate quorum for a sitting from the body config + live attendance.
 * Board adjourned sittings additionally require the Founder present:
 * 3 present without the Founder FAILS, however many attend.
 */
export function evaluateQuorum(
  body: BodyConfigView,
  attendance: readonly AttendanceRecord[],
): QuorumEvaluation {
  const presentCount = computePresent(attendance);
  const required = resolveQuorumRequired(body);
  const founderPresent =
    typeof body.founderPresent === 'boolean' ? body.founderPresent : isFounderPresent(attendance);
  const founderRequired = body.bodyType === 'board' && body.isAdjournedSitting === true;
  const founderConditionMet = !founderRequired || founderPresent;
  return {
    met: presentCount >= required && founderConditionMet,
    presentCount,
    required,
    founderRequired,
    founderConditionMet,
    founderPresent,
  };
}

/**
 * Chair quorum verification: the gate every motion open must pass.
 * Returns the evaluation plus `verified` (=== met) for the verify route.
 */
export function verifyQuorum(
  body: BodyConfigView,
  attendance: readonly AttendanceRecord[],
): QuorumEvaluation & { verified: boolean } {
  const evaluation = evaluateQuorum(body, attendance);
  return { ...evaluation, verified: evaluation.met };
}

/**
 * Whether a motion may open: the chair must ALREADY have verified quorum for
 * this sitting AND quorum must still be met at open time. Both conditions are
 * required — a stale verification with quorum since lost does not open.
 */
export function canOpenMotion(input: {
  quorumVerified: boolean;
  quorum: QuorumEvaluation;
}): boolean {
  return input.quorumVerified === true && input.quorum.met === true;
}

// ---------------------------------------------------------------------------
// Denominator snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot the eligible denominator at motion open. Returns defensive copies:
 * later joins, leaves, or caller-side mutation of the source arrays NEVER
 * change an open motion's snapshot, and a paused motion resumes with this
 * original snapshot (it is never retaken).
 */
export function snapshotDenominator(
  body: BodyConfigView,
  attendance: readonly AttendanceRecord[],
): DenominatorSnapshot {
  const eligibleUids = [...body.memberUids];
  const presentUids = computePresentUids(attendance);
  return {
    eligibleUids,
    presentUids,
    presentCount: presentUids.length,
    wholeBodyCount: eligibleUids.length,
  };
}

// ---------------------------------------------------------------------------
// Quorum change -> motion effects (report only; never mutates)
// ---------------------------------------------------------------------------

/**
 * Report what a quorum (re)evaluation means for each motion, e.g. after a
 * join or a leave recomputes quorum mid-meeting:
 * - quorum lost: `open` motions pause (`paused_quorum_lost`);
 * - quorum regained: `paused_quorum_lost` motions resume to `open`;
 * - CLOSED motions (passed / failed / tied-pending-casting), withdrawn
 *   motions, and motions already in the target state are untouched.
 * Pure report: inputs are not mutated; the caller applies resultingStatus.
 */
export function applyQuorumToMotions(
  motions: readonly MotionQuorumView[],
  quorum: QuorumEvaluation,
): MotionQuorumEffect[] {
  return motions.map((motion) => {
    if (!quorum.met && motion.status === 'open') {
      return {
        motionId: motion.motionId,
        previousStatus: motion.status,
        resultingStatus: 'paused_quorum_lost' as const,
        action: 'pause' as const,
      };
    }
    if (quorum.met && motion.status === 'paused_quorum_lost') {
      return {
        motionId: motion.motionId,
        previousStatus: motion.status,
        resultingStatus: 'open' as const,
        action: 'resume' as const,
      };
    }
    return {
      motionId: motion.motionId,
      previousStatus: motion.status,
      resultingStatus: motion.status,
      action: 'none' as const,
    };
  });
}
