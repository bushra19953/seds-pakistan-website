/**
 * Shared governance types for Phase 3 Part A (meetings, minutes, voting).
 *
 * Plain data only: no Firebase / Firestore imports, so this module is safe to
 * import from client components, server services, and pure engines alike.
 * The quorum engine (src/lib/governance/quorum-engine.ts) consumes the views
 * and record shapes defined here; callers pass plain data in and get plain
 * data out.
 */

/** Bodies that can hold a governed meeting (bodies.type, Phase 1 read contract). */
export type BodyType =
  | 'board'
  | 'nec'
  | 'council'
  | 'council_of_chapters'
  | 'general_body'
  | 'chapter_committee';

/**
 * Attendance mode for one member at one sitting.
 * `electronic` counts IDENTICALLY to `in_person` for quorum and voting (P-07).
 * `absent` never counts.
 */
export type AttendanceMode = 'in_person' | 'electronic' | 'absent';

/**
 * Plain view of one meeting_attendance record, as consumed by the engine.
 * `isPresent` is the stored derived flag (mode is not absent AND leftAt is
 * null); when it is absent the engine derives presence from `mode`/`leftAt`.
 * `leftAt` is an opaque timestamp value (ISO string, epoch ms, or Date) —
 * only its null-ness matters to the engine.
 */
export interface AttendanceRecord {
  uid: string;
  mode: AttendanceMode;
  isPresent?: boolean;
  leftAt?: unknown | null;
  /** Snapshot flag: this attendee is the Founder (adjourned-Board quorum + casting ballot). */
  isFounder?: boolean;
  displayName?: string;
}

/**
 * Read-only view of a body (bodies doc, Phase 1) plus the sitting facts the
 * engine needs. This is the ONLY source of quorum configuration for non-Board
 * bodies: the engine never infers membership or quorum from role tokens.
 */
export interface BodyConfigView {
  /** All eligible member uids of the body; the eligibility snapshot source. */
  memberUids: string[];
  bodyType: BodyType;
  /**
   * Quorum stored on the meeting at notice time. When set it wins over the
   * defaults (except that a Board adjourned sitting always requires 3 +
   * Founder — see evaluateQuorum).
   */
  quorumRequired?: number | null;
  /** Explicit quorum override carried on the body doc, if any. */
  quorumOverride?: number | null;
  /** True when this sitting is an adjourned reconvene of an earlier sitting. */
  isAdjournedSitting?: boolean;
  /**
   * Whether the Founder is present at this sitting. When omitted, the engine
   * derives it from attendance records carrying `isFounder: true`.
   */
  founderPresent?: boolean;
}

/** Majority rule copied from a decision class (decisionClasses doc, Phase 2). */
export type MajorityType =
  | 'ordinary_present_and_voting'
  | 'fraction_of_all_governors'
  | 'fraction_of_all_full_members'
  | 'fraction_of_all_representatives'
  | 'plurality'
  | 'single_person';

/** What a threshold fraction / majority is measured against. */
export type DenominatorKind =
  | 'present_and_voting'
  | 'all_governors'
  | 'all_full_members'
  | 'all_representatives'
  | 'snapshot_present';

/**
 * Read-only view of a decision class, as consumed at motion open.
 * `numerator`/`denominator` express the fraction for fraction classes
 * (e.g. 2/3 of all Governors is numerator 2, denominator 3).
 */
export interface DecisionClassView {
  id?: string;
  majorityType: MajorityType;
  numerator: number | null;
  denominator?: number | null;
  denominatorKind: DenominatorKind;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

/**
 * Threshold copied IMMUTABLY onto a motion at open and never re-read from the
 * class afterwards. `requiredCount` is computed at open for fraction types
 * from the denominator snapshot.
 */
export interface MotionThreshold {
  majorityType: MajorityType;
  numerator: number | null;
  denominator?: number | null;
  denominatorKind: DenominatorKind;
  requiredCount: number | null;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

/**
 * Denominator frozen at motion open. Later joins/leaves NEVER change an open
 * motion's snapshot; a paused motion resumes with this original snapshot.
 */
export interface DenominatorSnapshot {
  /** Every eligible uid of the body at open (copy — safe from caller mutation). */
  eligibleUids: string[];
  /** Uids present at open (in person or electronic — identical weight). */
  presentUids: string[];
  presentCount: number;
  /** eligibleUids.length at open; the "whole" for fraction thresholds. */
  wholeBodyCount: number;
}

/** A single ballot choice. */
export type BallotChoice = 'for' | 'against' | 'abstain';

/**
 * Plain view of one traceable ballot. A Founder casting ballot carries
 * `isCastingVote: true` and is ALWAYS tallied separately from ordinary votes.
 */
export interface BallotRecord {
  voterUid: string;
  choice: BallotChoice;
  isCastingVote?: boolean;
  isProxy?: boolean;
  proxyForUid?: string | null;
}

/** Ordinary vote tallies. Casting ballots are NEVER included here. */
export interface VoteTallies {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
}

/** Motion lifecycle statuses the quorum engine reasons about. */
export type MotionStatus =
  | 'open'
  | 'paused_quorum_lost'
  | 'closed_passed'
  | 'closed_failed'
  | 'closed_tied_pending_casting'
  | 'withdrawn';

/** Result of a quorum evaluation / verification. */
export interface QuorumEvaluation {
  /** True when the sitting may conduct business (and motions may open). */
  met: boolean;
  presentCount: number;
  /** The quorum number applied for this sitting. */
  required: number;
  /** True when this sitting's quorum rule includes a Founder-presence condition. */
  founderRequired: boolean;
  /** The Founder-presence condition itself (true when not required). */
  founderConditionMet: boolean;
  founderPresent: boolean;
}

/** Outcome of a threshold evaluation at motion close. */
export type ThresholdOutcome = 'passed' | 'failed' | 'tie_pending_casting';

/** Full threshold evaluation result, shaped to fill a motion's `result` map. */
export interface ThresholdEvaluation {
  outcome: ThresholdOutcome;
  /** Mirrors `outcome === 'passed'`. */
  thresholdMet: boolean;
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  /**
   * The denominator the threshold was measured against: present-and-voting
   * (for + against) for ordinary, the snapshot whole-body count for fraction
   * types, present-and-voting for plurality, 1 for single_person.
   */
  denominatorUsed: number;
  /** Votes-for required to pass (fraction types); null for ordinary/plurality. */
  requiredCount: number | null;
  /** True when a Founder casting ballot decided (or was recorded on) this motion. */
  castingVoteUsed: boolean;
  /** The casting choice, recorded SEPARATELY — never merged into the tallies. */
  castingChoice: BallotChoice | null;
}

/** The single Founder casting ballot on a tied motion. */
export interface CastingBallotRecord {
  voterUid: string;
  choice: BallotChoice;
  isCastingVote: true;
}

/** Minimal motion view the engine needs to report quorum-loss effects. */
export interface MotionQuorumView {
  motionId: string;
  status: MotionStatus;
}

/**
 * Report of what a quorum change means for one motion. The engine REPORTS;
 * it never mutates motions — the caller applies `resultingStatus`.
 */
export interface MotionQuorumEffect {
  motionId: string;
  previousStatus: MotionStatus;
  resultingStatus: MotionStatus;
  action: 'pause' | 'resume' | 'none';
}
