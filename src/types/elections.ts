/**
 * Phase 3 Elections suite + AGM types.
 *
 * Spec: bylaws_incorporation/implementation/fragments/elections_partB.md
 * (Workstream B - Elections Suite and AGM).
 *
 * Elections exist ONLY for Governor seats (the 2 Member Governor seats).
 * Any attempt to create an election for a non-Governor office is rejected
 * server-side. Elections are never held for the National President or any
 * national officer (those are appointed, not elected).
 */

/** The only offices an election may be held for. */
export type GovernorSeatKey = "member_governor_1" | "member_governor_2";

export const GOVERNOR_SEATS: readonly GovernorSeatKey[] = [
  "member_governor_1",
  "member_governor_2",
] as const;

export function isGovernorSeat(value: unknown): value is GovernorSeatKey {
  return (
    typeof value === "string" &&
    (GOVERNOR_SEATS as readonly string[]).includes(value)
  );
}

/** Lifecycle states of an election. */
export type ElectionStatus =
  | "draft"
  | "timetable_published"
  | "nominations_open"
  | "nominations_closed"
  | "roll_frozen"
  | "voting_open"
  | "voting_closed"
  | "declared"
  | "cancelled";

/**
 * Returning Officer appointment for one named election.
 * Term starts on appointment for that election and ends when the result
 * for that election is declared. The RO can never be a candidate in the
 * election they run (enforced server-side at election create, nomination
 * create and nomination accept).
 */
export interface ReturningOfficer {
  uid: string;
  displayName: string;
  appointedByUid: string;
  appointedAt: string; // ISO timestamp
  /** Set when the result is declared; the RO term ends at this instant. */
  termEndedAt: string | null;
}

/** Timetable derived from Procedure Manual T-30 (days before election day). */
export interface ElectionTimetable {
  electionDay: string; // ISO date (YYYY-MM-DD)
  timetablePublishedOn: string; // ISO date
  nominationsOpenOn: string; // ISO date
  nominationsCloseOn: string; // ISO date
  rollFreezeOn: string; // ISO date
  votingOpenOn: string; // ISO date
  votingCloseOn: string; // ISO date
  declarationOn: string; // ISO date
}

/** One entry on the frozen electoral roll. Only these members may vote. */
export interface RollEntry {
  uid: string;
  displayName: string;
  frozenAt: string; // ISO timestamp
}

export type NominationStatus = "pending" | "accepted" | "rejected" | "withdrawn";

export interface Nomination {
  id: string;
  electionId: string;
  candidateUid: string;
  candidateName: string;
  seat: GovernorSeatKey;
  status: NominationStatus;
  submittedAt: string; // ISO timestamp
  decidedByUid: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

/** Record of a tie broken by lot (Constitution Sec 7.8). */
export interface TieLotDraw {
  tiedCandidateUids: string[];
  winnerUid: string;
  /** Random value in [0, 1) that produced the draw, kept for audit. */
  drawValue: number;
  drawnByUid: string;
  drawnAt: string; // ISO timestamp
}

export interface ElectionResult {
  seat: GovernorSeatKey;
  winnerUid: string;
  winnerName: string;
  /** Vote counts per candidate uid. Counts are public; ballots are not. */
  tally: Record<string, number>;
  tieLotDraw: TieLotDraw | null;
  declaredByUid: string;
  declaredAt: string; // ISO timestamp
  certificateId: string;
}

export interface Election {
  id: string;
  seat: GovernorSeatKey;
  title: string;
  status: ElectionStatus;
  returningOfficer: ReturningOfficer;
  timetable: ElectionTimetable;
  /** Null until the roll is frozen. */
  roll: RollEntry[] | null;
  rollFrozenAt: string | null;
  result: ElectionResult | null;
  createdByUid: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

/**
 * A single anonymised ballot. Stored in a collection SEPARATE from the
 * meeting motion ballots: a ballot carries NO voter identity, only a
 * one-way receipt hash so a voter can verify inclusion without the
 * system being able to link the vote back to them.
 */
export interface ElectionBallot {
  id: string;
  electionId: string;
  candidateUid: string;
  receiptHash: string;
  castAt: string; // ISO timestamp
}

/** Proof a member has voted (no candidate link, prevents double voting). */
export interface BallotCastRecord {
  electionId: string;
  voterUid: string;
  receiptHash: string;
  castAt: string; // ISO timestamp
}

/** Signed election certificate generated at declaration. */
export interface ElectionCertificate {
  id: string;
  electionId: string;
  seat: GovernorSeatKey;
  winnerUid: string;
  winnerName: string;
  declaredByUid: string; // the Returning Officer
  declaredAt: string; // ISO timestamp
  /** Deterministic signature string over the certificate payload. */
  signature: string;
}
