/**
 * Circular resolutions — shared types (ws-a.md §3.12, §3.5, §3.9).
 * No Firebase / I/O imports. Imported by client and server.
 * Timestamps are plain Dates in this pure layer; the server service converts
 * to Firestore Timestamps at the persistence boundary.
 */

export type CircularStatus = "draft" | "circulating" | "passed" | "lapsed" | "withdrawn";

export type MajorityType =
  | "ordinary_present_and_voting"
  | "fraction_of_all_governors"
  | "fraction_of_all_full_members"
  | "fraction_of_all_representatives"
  | "plurality"
  | "single_person";

export type DenominatorKind =
  | "present_and_voting"
  | "all_governors"
  | "all_full_members"
  | "all_representatives"
  | "snapshot_present";

/**
 * Threshold copy (ws-a §3.5 shape, reused verbatim for circulars per the
 * Phase 3 slice brief): copied IMMUTABLY from the decision class at circular
 * creation and never re-read afterwards. `requiredCount` is computed at copy
 * time for fraction-of-all classes from the whole-body count known then;
 * for circulars the binding snapshot count is the governor snapshot taken at
 * circulation, so the service recomputes the effective required count from
 * the COPIED fraction (numerator/denominatorKind) against that snapshot —
 * never from a fresh read of the class. See threshold.ts.
 */
export interface CircularThreshold {
  majorityType: MajorityType;
  /** Fraction numerator for fraction types (e.g. 2 for 2/3); null otherwise. */
  numerator: number | null;
  /** Fraction denominator for fraction types (e.g. 3 for 2/3); null otherwise. */
  denominator: number | null;
  denominatorKind: DenominatorKind | string;
  requiredCount: number | null;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
}

/** Read view of a decisionClasses doc (ws-a §3.9). Consumed, never written. */
export interface DecisionClassView {
  id: string;
  label: string;
  assignedBodyType: string;
  majorityType: MajorityType;
  numerator: number | null;
  denominatorKind: DenominatorKind | string;
  consentRequired: boolean;
  isReservedMatter: boolean;
  filingFlag: boolean;
  sourceRow: string;
}

/** One Governor approval signature (ws-a §3.12 signatures[] entry). */
export interface CircularSignature {
  uid: string;
  displayName: string;
  signedAt: Date;
  statement: "I approve this resolution";
}

export type CircularVoteChoice = "for" | "against" | "abstain";

/**
 * One asynchronous vote. A "for" vote IS a ws-a signature: it is mirrored
 * into `signatures` / `signedCount` so the §3.12 record shape holds exactly.
 * "against" / "abstain" votes exist so classes whose majorityType is
 * ordinary_present_and_voting can be decided by the present-and-voting rule
 * the slice brief requires; Board classes are fraction-of-all in practice
 * (ws-a §3.12: majority of ALL Governors), where only "for" counts move the
 * outcome and non-votes count against passage by absence.
 */
export interface CircularVote {
  uid: string;
  displayName: string;
  choice: CircularVoteChoice;
  castAt: Date;
}

/** circular_resolutions/{resolutionId} (ws-a §3.12) + threshold copy. */
export interface CircularResolution {
  id: string;
  bodyId: string;
  /** Copied from the body at creation; Board only in v1 (ws-a §3.12). */
  bodyType: string;
  title: string;
  /** Exact resolution text; lands verbatim in the decisions register entry. */
  text: string;
  decisionClassId: string;
  /** REQUIRED for circulation; must be a decided Consent (ws-a §4.7). */
  consentId: string | null;
  status: CircularStatus;
  /** Frozen threshold copy taken at creation. Never mutated after. */
  threshold: CircularThreshold;
  circulatedAt: Date | null;
  /** circulatedAt + 7 days (ws-a §3.12). */
  closesAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** ALL Governors at circulation; the fraction-of-all denominator. */
  governorUidsSnapshot: string[];
  signatures: CircularSignature[];
  votes: CircularVote[];
  signedCount: number;
  decisionId: string | null;
  filingTaskId: string | null;
}

export interface CircularTallies {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  /** Eligible voters who have not cast any vote. */
  notVoted: number;
}
