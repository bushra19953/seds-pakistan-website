/**
 * Decisions register client (ws-a §3.9; Meetings Core contract §6) — server only.
 *
 * This is the ONLY writer to the `decisions` collection from Workstream A.
 * Every other governance service (motions close, circular close, urgent
 * submit/ratify/void, referrals) calls this module; no other file in this
 * workstream imports the decisions collection name.
 *
 * APPEND-ONLY CONTRACT: entries are never edited or deleted. The only status
 * transitions this client performs are the two owned by ws-a §6.5:
 *   pending_ratification -> ratified
 *   pending_ratification -> void
 * Any other transition request throws `decision_transition_not_owned`. If the
 * Phase 2 lifecycle engine exposes a transition function when it lands, this
 * client's transition method is the single seam that delegates to it
 * (ADAPTER); call sites do not change.
 *
 * ADAPTER (store): persistence goes through the `DecisionsClient` interface.
 * `InMemoryDecisionsClient` implements it for local tests. A Firestore
 * implementation maps writeDecision -> add() on `decisions`,
 * getDecision -> doc get, transitionDecisionStatus -> a transaction that
 * re-reads the entry, asserts current status is pending_ratification, and
 * writes the new status plus the transition payload fields.
 */

export type DecisionSource =
  | "meeting_motion"
  | "circular"
  | "urgent"
  | "reversal"
  | "override"
  | "ratification";

export type DecisionOutcome = "passed" | "failed" | "effective" | "ratified" | "void";

export type DecisionStatus =
  | "effective"
  | "pending_ratification"
  | "ratified"
  | "void"
  | "superseded"
  | "referred";

export interface DecisionVotingSummary {
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  denominator: number;
  /** The threshold copy the outcome was evaluated against (opaque at this layer). */
  thresholdApplied: Record<string, unknown>;
}

/** Write input per ws-a §3.9 — exactly the fields a caller may supply. */
export interface DecisionEntryInput {
  bodyId: string;
  decisionClassId: string;
  source: DecisionSource;
  sourceId: string;
  text: string;
  outcome: DecisionOutcome;
  votingSummary: DecisionVotingSummary;
  consentId: string | null;
  decidedAt: Date;
  effectiveAt: Date;
  status: DecisionStatus;
  supersedesDecisionId: string | null;
  retentionUntil: Date;
}

/** A stored register entry: the write input plus its register id. */
export interface DecisionEntry extends DecisionEntryInput {
  id: string;
  /** Set only by the pending_ratification -> void transition (ws-a §6.5). */
  voidedAt?: Date | null;
  /** Retroactive void takes effect FROM the original decision time (§6.5). */
  voidEffectiveFrom?: Date | null;
  /** Set only by the pending_ratification -> ratified transition. */
  ratifiedAt?: Date | null;
}

export class DecisionsError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "DecisionsError";
  }
}

const REQUIRED_STRING_FIELDS: Array<keyof DecisionEntryInput> = [
  "bodyId",
  "decisionClassId",
  "sourceId",
  "text",
];

/**
 * Validate a write input and build the stored entry. Pure: no I/O.
 * Throws DecisionsError(422, decision_entry_invalid) on any missing or
 * mistyped required field, so a malformed entry can never reach the store.
 */
export function buildDecisionEntry(input: DecisionEntryInput, id: string): DecisionEntry {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof input[field] !== "string" || (input[field] as string).length === 0) {
      throw new DecisionsError(
        "decision_entry_invalid",
        422,
        `Decision entry is missing required field: ${field}`,
      );
    }
  }
  if (!(input.decidedAt instanceof Date) || !(input.effectiveAt instanceof Date) || !(input.retentionUntil instanceof Date)) {
    throw new DecisionsError(
      "decision_entry_invalid",
      422,
      "Decision entry decidedAt, effectiveAt and retentionUntil must be Dates",
    );
  }
  if (
    !input.votingSummary ||
    typeof input.votingSummary.votesFor !== "number" ||
    typeof input.votingSummary.votesAgainst !== "number" ||
    typeof input.votingSummary.abstentions !== "number" ||
    typeof input.votingSummary.denominator !== "number" ||
    typeof input.votingSummary.thresholdApplied !== "object"
  ) {
    throw new DecisionsError(
      "decision_entry_invalid",
      422,
      "Decision entry votingSummary is incomplete",
    );
  }
  return { ...input, id, voidedAt: null, voidEffectiveFrom: null, ratifiedAt: null };
}

/** The only two status transitions Workstream A owns (ws-a §3.9, §6.5). */
export const OWNED_DECISION_TRANSITIONS: Readonly<Record<string, readonly DecisionStatus[]>> = {
  pending_ratification: ["ratified", "void"],
};

export interface DecisionTransitionPayload {
  /** Required for the void transition: when the void was recorded. */
  voidedAt?: Date;
  /** Required for the void transition: the original decision's createdAt. */
  voidEffectiveFrom?: Date;
  /** Set on the ratified transition. */
  ratifiedAt?: Date;
}

export interface DecisionsClient {
  /** Append a new entry. Returns the stored entry (with its register id). */
  writeDecision(input: DecisionEntryInput): Promise<DecisionEntry>;
  getDecision(id: string): Promise<DecisionEntry | null>;
  /**
   * Perform one of the two owned transitions. Throws
   * DecisionsError(409, decision_transition_not_owned) for anything else,
   * including transitions from a terminal or non-pending status.
   */
  transitionDecisionStatus(
    id: string,
    to: DecisionStatus,
    payload?: DecisionTransitionPayload,
  ): Promise<DecisionEntry>;
}

/** In-memory implementation for local tests; ids are sequential by default. */
export class InMemoryDecisionsClient implements DecisionsClient {
  private entries = new Map<string, DecisionEntry>();
  private seq = 0;

  constructor(private idFactory: () => string = () => `decision_${++this.seq}`) {}

  async writeDecision(input: DecisionEntryInput): Promise<DecisionEntry> {
    const entry = buildDecisionEntry(input, this.idFactory());
    this.entries.set(entry.id, entry);
    return entry;
  }

  async getDecision(id: string): Promise<DecisionEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async transitionDecisionStatus(
    id: string,
    to: DecisionStatus,
    payload: DecisionTransitionPayload = {},
  ): Promise<DecisionEntry> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new DecisionsError("decision_not_found", 404, `No decisions entry with id ${id}`);
    }
    const allowed = OWNED_DECISION_TRANSITIONS[entry.status] ?? [];
    if (!allowed.includes(to)) {
      throw new DecisionsError(
        "decision_transition_not_owned",
        409,
        `Workstream A cannot move a decisions entry from ${entry.status} to ${to}; ` +
          "the only owned transitions are pending_ratification -> ratified and pending_ratification -> void",
      );
    }
    const updated: DecisionEntry = { ...entry, status: to };
    if (to === "void") {
      updated.voidedAt = payload.voidedAt ?? null;
      updated.voidEffectiveFrom = payload.voidEffectiveFrom ?? null;
    }
    if (to === "ratified") {
      updated.ratifiedAt = payload.ratifiedAt ?? null;
    }
    this.entries.set(id, updated);
    return updated;
  }

  /** Test helper: every entry written so far, in write order. */
  all(): DecisionEntry[] {
    return [...this.entries.values()];
  }
}
