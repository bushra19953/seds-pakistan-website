/**
 * Elections cast PRIMACY path (cutover program, Option A).
 *
 * When `isSupaPrimary('elections')` is ON, a cast is exactly ONE
 * transactional call — `tx_elections_cast_ballot`
 * (src/lib/supa/sql/tx_elections_cast_ballot.sql) through the real
 * adapter's `tx()` primitive — replacing the sequential seam writes
 * of the flipped (non-primary) path:
 *
 *   advisory lock -> idempotency replay check -> token / poll /
 *   marker / choice validation -> atomic marker claim -> conditional
 *   token redemption -> ballot write -> counters re-derived at write
 *   time (F2) -> idempotency record — all inside Postgres, so the
 *   F3 split / double-persist flaw class cannot occur on this path.
 *
 * Failure classification (F3 preserved):
 *  - The call never reaches the function (no adapter, an adapter
 *    without `tx()`, or SupaUnavailableError): PRE-WRITE
 *    infrastructure failure. `castBallotPrimary` returns
 *    `{ kind: "unavailable" }` and castBallot falls back to the
 *    Firestore transaction as a whole — the only fallback on this
 *    path.
 *  - The function returns a business rejection: mapped by
 *    castBallot to the same ElectionError code/status the
 *    Firestore and sequential-Supa paths produce.
 *  - `tx()` throws anything else: the outcome of the single call is
 *    not knowable as "nothing landed" at this layer, so castBallot
 *    surfaces `SupaCastPrimaryError` — an infrastructure error with
 *    no domain code — and NEVER falls back (a fallback after a
 *    possibly-committed cast is exactly the double-persist F3
 *    forbids).
 *
 * ANONYMITY: this module receives the voter uid ONLY to build the
 * foundation-mandated deterministic idempotency key
 * (`ballot:<electionId>:<voterUid>`) and the one-way HMAC marker id.
 * The uid and the plaintext token never appear in the tx arguments:
 * the token travels as its sha256 hash and the ballot argument is
 * the exact anonymous payload ({ electionId, choices, castDay,
 * isBlank }). The idempotency record the function stores contains
 * only { applied, duplicate } — no choice linkage (see the SQL
 * file header).
 */

import { randomUUID } from "crypto";
import { SupaUnavailableError } from "@/lib/supa/adapter";
import {
  castDayBucket,
  castMarkerId,
  hashBallotToken,
  pollWindowId,
} from "@/lib/elections/anonymity";
import { millisOf } from "./election-db";
import { resolveElectionSupaAdapter } from "./election-supa";

export const CAST_TX_FUNCTION = "tx_elections_cast_ballot";

/** Structural shape of the real adapter's tx() primitive. */
export interface CastTxAdapter {
  tx<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ): Promise<T>;
}

export interface CastTxOutcome {
  applied: boolean;
  duplicate: boolean;
  reason: string | null;
}

export type CastPrimaryAttempt =
  | { kind: "done"; outcome: CastTxOutcome }
  | { kind: "unavailable" };

/**
 * Infrastructure failure of the primary cast call whose landed
 * state is unknowable at this layer. Deliberately NOT an
 * ElectionError and carries no domain `code`: castBallot rethrows
 * it untouched — no Firestore fallback, no further writes.
 */
export class SupaCastPrimaryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SupaCastPrimaryError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

let injectedTxAdapter: CastTxAdapter | null | undefined;

/** Test-only: inject a tx-capable adapter (null forces "unavailable"). */
export function __setCastTxAdapterForTests(
  adapter: CastTxAdapter | null | undefined,
): void {
  injectedTxAdapter = adapter;
}

/**
 * Resolve the tx-capable adapter for the primary cast: an injected
 * adapter (tests) wins; otherwise the core seam's adapter (the real
 * src/lib/supa adapter, which carries tx()) when it actually
 * exposes tx(). Anything else resolves to null = unavailable.
 */
export async function resolveCastTxAdapter(): Promise<CastTxAdapter | null> {
  if (injectedTxAdapter !== undefined) return injectedTxAdapter;
  const adapter = (await resolveElectionSupaAdapter()) as unknown as
    | (CastTxAdapter & Record<string, unknown>)
    | null;
  if (adapter && typeof adapter.tx === "function") return adapter;
  return null;
}

/** The deterministic idempotency key for one voter's one cast. */
export function castIdempotencyKey(electionId: string, uid: string): string {
  return `ballot:${electionId}:${uid}`;
}

export interface CastPrimaryInput {
  uid: string;
  token: string;
  choices: string[];
}

/**
 * Run the ONE tx call for a primary cast. Validation inputs the SQL
 * re-checks under its lock (poll window from the locked election
 * row, certified candidates, seats) are passed as arguments; the
 * election snapshot the caller already read supplies only the
 * marker's pollWindow value and nothing the SQL trusts for a
 * decision — every decision state is re-read inside the function.
 */
export async function castBallotPrimary(
  electionId: string,
  input: CastPrimaryInput,
  election: { timetable: unknown; seats: number },
  certifiedUids: Set<string>,
  nowMillis: number,
): Promise<CastPrimaryAttempt> {
  const adapter = await resolveCastTxAdapter();
  if (!adapter) return { kind: "unavailable" };

  const castDay = castDayBucket(nowMillis);
  const pollOpenAt = millisOf(
    (election.timetable as { pollOpenAt?: unknown })?.pollOpenAt,
  );
  const tokenHash = hashBallotToken(input.token, electionId);
  const markerId = castMarkerId(electionId, input.uid);
  const choices = [...(input.choices ?? [])];

  const args: Record<string, unknown> = {
    p_election_id: electionId,
    p_token_hash: tokenHash,
    p_marker_id: markerId,
    p_marker: {
      electionId,
      castDay,
      pollWindow: pollWindowId(electionId, pollOpenAt),
    },
    p_ballot_id: randomUUID(),
    p_ballot: {
      electionId,
      choices,
      castDay,
      isBlank: choices.length === 0,
    },
    p_certified_candidate_uids: [...certifiedUids],
    p_seats: election.seats,
    p_now: new Date(nowMillis).toISOString(),
    p_cast_day: castDay,
  };

  let raw: unknown;
  try {
    raw = await adapter.tx<unknown>(CAST_TX_FUNCTION, args, {
      idempotencyKey: castIdempotencyKey(electionId, input.uid),
    });
  } catch (err) {
    if (err instanceof SupaUnavailableError) {
      // The call never reached the function: pre-write failure.
      return { kind: "unavailable" };
    }
    throw new SupaCastPrimaryError(
      `castBallot: primary tx ${CAST_TX_FUNCTION} failed for election ${electionId}; ` +
        "not falling back to Firestore (the cast's landed state is unknowable at this layer)",
      err,
    );
  }

  // PostgREST returns a table-returning function as an array of
  // rows; a single-object shape is accepted for fake adapters.
  const row = (Array.isArray(raw) ? raw[0] : raw) as
    | Partial<CastTxOutcome>
    | undefined;
  if (!row || typeof row.applied !== "boolean") {
    throw new SupaCastPrimaryError(
      `castBallot: primary tx ${CAST_TX_FUNCTION} returned a malformed outcome for election ${electionId}`,
    );
  }
  return {
    kind: "done",
    outcome: {
      applied: row.applied,
      duplicate: row.duplicate === true,
      reason: typeof row.reason === "string" ? row.reason : null,
    },
  };
}
