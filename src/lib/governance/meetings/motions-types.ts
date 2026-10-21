/**
 * Motions — shared types (ws-a.md §3.5, §3.6, §3.9).
 *
 * Pure types only: no Firebase, Firestore, or Next imports, so this module is
 * importable by client components, server services, and tests alike.
 * Timestamps are plain `Date` at this layer; the server service converts
 * Firestore Timestamps to Dates on read and writes Dates / server timestamps
 * on write.
 *
 * This is the canonical Motion model for the Phase 3 meetings workstream.
 * Sibling slices (ballots, minutes, UI) consume these types; their local
 * `MotionRef` / view adapters should be replaced with imports from here.
 */

export type BodyType =
  | "board"
  | "nec"
  | "council"
  | "council_of_chapters"
  | "general_body"
  | "chapter_committee";

/** ws-a §3.5 motion status enum — exact values, do not rename. */
export type MotionStatus =
  | "open"
  | "paused_quorum_lost"
  | "closed_passed"
  | "closed_failed"
  | "closed_tied_pending_casting"
  | "withdrawn";

export type VotingMethod = "show_of_hands" | "electronic_poll" | "secret_ballot";

export type BallotChoice = "for" | "against" | "abstain";

/** ws-a §3.5 threshold.majorityType enum. */
export type MajorityType =
  | "ordinary_present_and_voting"
  | "fraction_of_all_governors"
  | "fraction_of_all_full_members"
  | "fraction_of_all_representatives"
  | "plurality"
  | "single_person";

/** ws-a §3.5 threshold.denominatorKind enum. */
export type DenominatorKind =
  | "present_and_voting"
  | "all_governors"
  | "all_full_members"
  | "all_representatives"
  | "snapshot_present";

/**
 * The threshold copy stored on a motion at open time (ws-a §3.5).
 *
 * IMMUTABILITY CONTRACT: this object is copied from the decision class once,
 * at motion creation, deep-frozen by `copyThresholdFromClass`, and never
 * re-read from the class afterwards. Later edits to the decision-class
 * matrix must not change an existing motion's threshold. There is no update
 * path that mutates it (see `guardMotionPatch` in motions-lifecycle.ts).
 *
 * `fractionDenominator` is an ADAPTER extension: ws-a §3.9 lists only
 * `numerator` on the class, but §6.2 evaluates fractions such as 2/3 and 3/4,
 * which a lone numerator cannot express. When the Phase 2 decision-class
 * build lands, if it stores the fraction differently (e.g. numerator as a
 * decimal), only the adapter in decision-class-adapter.ts changes; motions
 * already opened keep the copy made here.
 */
export interface MotionThreshold {
  majorityType: MajorityType;
  /** Fraction numerator (e.g. 2 for 2/3) or null for non-fraction types. */
  numerator: number | null;
  /** ADAPTER extension: fraction denominator (e.g. 3 for 2/3); null otherwise. */
  fractionDenominator: number | null;
  denominatorKind: DenominatorKind;
  /**
   * Computed at open for fraction types from the denominator snapshot
   * (ws-a §3.5). Null for ordinary / plurality types.
   */
  requiredCount: number | null;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

/** ws-a §3.5 denominator snapshot, frozen at motion open. */
export interface DenominatorSnapshot {
  eligibleUids: string[];
  presentUids: string[];
  presentCount: number;
  wholeBodyCount: number;
}

/**
 * Per-motion interest disclosure (ws-a §3.6, Constitution 14.4 via minutes
 * field (c)). NON-GOAL N1: a disclosure is recorded and nothing more — it
 * never blocks a ballot, never excludes a voter from quorum or totals, and
 * never auto-abstains anyone. There is deliberately no recusal field here.
 */
export interface InterestDisclosure {
  hasInterest: boolean;
  description: string;
  relatedPartyName: string | null;
}

/** A disclosure captured against a motion, with who declared it and when. */
export interface InterestDisclosureRecord {
  uid: string;
  disclosure: InterestDisclosure;
  recordedAt: Date;
}

/** ws-a §3.5 result map, written once at final close. */
export interface MotionResult {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  denominatorUsed: number;
  thresholdMet: boolean;
  castingVoteUsed: boolean;
}

/** ws-a §3.5 motions/{motionId} document shape (pure form). */
export interface Motion {
  id: string;
  /** Null only for the circular-ratification link case (ws-a §3.5, §6.5). */
  meetingId: string | null;
  bodyId: string;
  /**
   * Copied from the meeting at open. Not in the §3.5 field list; carried so
   * the threshold engine can apply the Board/Council casting-ballot rule
   * (Doc 04 §4.6) without a second meeting read at close time.
   */
  bodyType: BodyType | string;
  /** Exact motion text; lands verbatim in minutes field (d) and decisions. */
  text: string;
  proposerUid: string;
  decisionClassId: string;
  /** Copied immutably at open — see MotionThreshold contract above. */
  threshold: MotionThreshold;
  denominatorSnapshot: DenominatorSnapshot;
  method: VotingMethod;
  secretDemandedBy: string[];
  status: MotionStatus;
  /**
   * Interest disclosures captured per motion (task slice requirement;
   * ballots also carry a per-ballot disclosure per §3.6 — minutes field (c)
   * is generated from disclosures, and a disclosure never gates a vote, N1).
   */
  disclosures: InterestDisclosureRecord[];
  openedAt: Date;
  openedBy: string;
  closedAt: Date | null;
  closedBy: string | null;
  result: MotionResult | null;
  decisionId: string | null;
  supersedesDecisionId: string | null;
  reversesDecisionId: string | null;
  consentId: string | null;
  /** Set when the class matrix check warned instead of blocking (warn mode). */
  matrixWarning: string | null;
  /** Optional matter key for the §6.4 conflict check; null = no check. */
  subjectRef: string | null;
  /** Set when this motion approves a minutes doc (ws-a §6.3). */
  minutesApprovalFor: string | null;
}

/**
 * The decision-class shape this workstream consumes (ws-a §3.9). The matrix
 * itself is a Phase 2 build; this workstream only reads it through the
 * adapter in decision-class-adapter.ts.
 */
export interface DecisionClassView {
  id: string;
  label: string;
  assignedBodyType: string;
  majorityType: MajorityType;
  numerator: number | null;
  /** ADAPTER extension — see MotionThreshold.fractionDenominator. */
  fractionDenominator: number | null;
  denominatorKind: DenominatorKind;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
  /** Doc 04 Article 5 row, e.g. "5.54". */
  sourceRow: string;
  /**
   * Phase 2 enforcement flag (ws-a §3.9): "enforce" blocks motions whose
   * class is assigned to a different body; "warn" proceeds with a stamped
   * matrixWarning. Absent on a class doc = treated as "warn".
   */
  enforcementMode?: "enforce" | "warn" | null;
}

/** Vote tallies fed to the threshold engine at close (ws-a §6.2). */
export interface VoteTallies {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
}

export type ThresholdOutcome = "passed" | "failed" | "tie_pending_casting";

export interface ThresholdEvaluation {
  outcome: ThresholdOutcome;
  thresholdMet: boolean;
  /** The denominator the evaluation actually used (for the result map). */
  denominatorUsed: number;
  castingVoteUsed: boolean;
}
