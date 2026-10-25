/**
 * The ballot anonymity engine (spec Section 3.4). The single largest
 * and most security-critical module in this workstream.
 *
 * Four stores, deliberately separated; no document joins a voter to a
 * choice:
 *  (a) eligibility_tokens/{tokenHash} - bearer token hashes, NO uid.
 *  (b) cast_markers/{markerId} - HMAC(pepper, electionId:uid), NO choice.
 *  (c) ballots/{randomUuid} - choices only, coarse castDay, NO identity.
 *  (d) token_issuance/{issuanceId} - internal index keyed by the same
 *      one-way HMAC as the marker, holding only the live token hash so
 *      issue/reissue rules can be enforced without storing a uid on the
 *      token doc.
 *
 * The cast runs as ONE transaction (spec 3.4(d)): the SESSION
 * identifies the voter for the marker check; the TOKEN authorises the
 * ballot. The uid is used to compute the marker and is then discarded;
 * the ballot write receives no uid. Poll hours are enforced inside the
 * transaction, so a lagging lifecycle sweep can never admit a late
 * ballot (spec 6.3 step 2).
 */

import { randomUUID } from "crypto";
import { ElectionError } from "./election-ports";
import {
  type Db,
  tsFromMillis,
  millisOf,
  getElectionOrThrow,
} from "./election-db";
import {
  generateBallotToken,
  hashBallotToken,
  castMarkerId,
  tokenIssuanceId,
  castDayBucket,
  pollWindowId,
} from "@/lib/elections/anonymity";
import { listCertifiedCandidates } from "./election-nominations";
import { isOnFrozenRoll } from "./election-roll";
import { writeElectionAudit } from "./election-audit";
import {
  electionsSupaEnabled,
  getElectionSupaAdapter,
  supaDeleteSubDoc,
  supaGetSubDoc,
  supaGetTopDoc,
  supaInsertSubDocIfAbsent,
  supaListSubDocs,
  supaSetSubDoc,
  supaUpdateSubDocIf,
  supaUpdateTopDoc,
} from "./election-domain-supa";
import { resolveElectionSupaAdapter } from "./election-supa";

function tokensColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("eligibility_tokens");
}
function markersColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("cast_markers");
}
function ballotsColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("ballots");
}

// ---------------------------------------------------------------------------
// Data-access helpers: the ONLY branch point between Firestore and
// Supabase for the four ballot subcollections (eligibility_tokens,
// cast_markers, ballots, token_issuance -> fs_group_<name> tables).
// The anonymity separation is preserved exactly: the same four stores,
// the same fields, no new joins. Timestamp fields (tokens:
// issuedAt/expiresAt/redeemedAt; issuance: issuedAt) are converted by
// the seam (Timestamp -> ISO on write, ISO -> Timestamp-shaped object
// on read), so millisOf(expiresAt) sees the same millis. Flag OFF /
// unconfigured / any Supabase error -> Firestore helper.
// ---------------------------------------------------------------------------

type BallotSub =
  | "eligibility_tokens"
  | "cast_markers"
  | "ballots"
  | "token_issuance";

interface SubDoc {
  id: string;
  data: Record<string, unknown>;
}

function subColl(db: Db, electionId: string, sub: BallotSub) {
  return db.collection("elections").doc(electionId).collection(sub);
}

async function getSubDoc(
  db: Db,
  electionId: string,
  sub: BallotSub,
  docId: string,
): Promise<SubDoc | null> {
  if (electionsSupaEnabled()) {
    try {
      return await supaGetSubDoc(electionId, sub, docId);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await subColl(db, electionId, sub).doc(docId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() as Record<string, unknown> };
}

async function listSubDocs(
  db: Db,
  electionId: string,
  sub: BallotSub,
): Promise<SubDoc[]> {
  if (electionsSupaEnabled()) {
    try {
      return await supaListSubDocs(electionId, sub);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await subColl(db, electionId, sub).get();
  return snap.docs.map(
    (d: { id: string; data: () => Record<string, unknown> }) => ({
      id: d.id,
      data: d.data(),
    }),
  );
}

async function setSubDoc(
  db: Db,
  electionId: string,
  sub: BallotSub,
  docId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaSetSubDoc(electionId, sub, docId, data);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await subColl(db, electionId, sub).doc(docId).set(data);
}

async function deleteSubDoc(
  db: Db,
  electionId: string,
  sub: BallotSub,
  docId: string,
): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaDeleteSubDoc(electionId, sub, docId);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await subColl(db, electionId, sub).doc(docId).delete();
}

export async function issueBallotToken(
  db: Db,
  electionId: string,
  uid: string,
  opts: { reissue?: boolean } = {},
  nowMillis: number = Date.now(),
): Promise<{ token: string }> {
  const election = await getElectionOrThrow(db, electionId);
  const pollOpenAt = millisOf(election.timetable.pollOpenAt);
  const pollCloseAt = millisOf(election.timetable.pollCloseAt);

  if (election.status !== "poll_open" && election.status !== "candidates_certified") {
    throw new ElectionError(
      "poll_not_open",
      409,
      "Ballot tokens are issued only on poll day for a certified election.",
    );
  }
  if (nowMillis >= pollCloseAt) {
    throw new ElectionError("poll_closed", 410, "The poll has closed.");
  }
  if (nowMillis < pollOpenAt && election.status !== "poll_open") {
    // Tokens may be issued on poll day ahead of the exact open instant
    // only when the RO has opened the poll; otherwise wait for the poll.
    throw new ElectionError(
      "poll_not_open",
      409,
      "The poll has not opened yet.",
    );
  }
  if (!(await isOnFrozenRoll(db, electionId, uid))) {
    throw new ElectionError(
      "not_on_roll",
      403,
      "Only members on the frozen voter roll may receive a ballot token.",
    );
  }

  const markerDoc = await getSubDoc(
    db,
    electionId,
    "cast_markers",
    castMarkerId(electionId, uid),
  );
  if (markerDoc) {
    throw new ElectionError(
      "already_cast",
      409,
      "A ballot has already been cast for this voter.",
    );
  }

  const issuanceId = tokenIssuanceId(electionId, uid);
  const issuanceDoc = await getSubDoc(db, electionId, "token_issuance", issuanceId);
  if (issuanceDoc) {
    const prevHash = issuanceDoc.data.tokenHash as string;
    const prevTokenDoc = await getSubDoc(db, electionId, "eligibility_tokens", prevHash);
    if (prevTokenDoc && prevTokenDoc.data.redeemedAt == null) {
      if (!opts.reissue) {
        throw new ElectionError(
          "token_already_issued",
          409,
          "A live ballot token has already been issued to this voter.",
        );
      }
      // Reissue invalidates the previous token doc (spec 3.4(a)).
      await deleteSubDoc(db, electionId, "eligibility_tokens", prevHash);
    }
  }

  const token = generateBallotToken();
  const tokenHash = hashBallotToken(token, electionId);
  await setSubDoc(db, electionId, "eligibility_tokens", tokenHash, {
    electionId,
    issuedAt: tsFromMillis(nowMillis),
    expiresAt: tsFromMillis(pollCloseAt),
    redeemedAt: null,
    redeemedDay: null,
  });
  await setSubDoc(db, electionId, "token_issuance", issuanceId, {
    tokenHash,
    issuedAt: tsFromMillis(nowMillis),
  });

  // The plaintext token is returned ONCE to the caller (the route) over
  // the authenticated response. It is never stored, never logged, and
  // never written into an audit payload.
  return { token };
}

/**
 * Infrastructure failure of a Supa cast AFTER a Supa write has
 * landed (F3). Deliberately NOT an ElectionError and carries no
 * domain `code`: castBallot rethrows it untouched — no Firestore
 * fallback, no further writes — because falling back would split
 * the cast across two backends and could double-persist.
 */
export class SupaCastPostWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SupaCastPostWriteError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

interface ElectionCounters {
  ballotsCast: number;
  markersCast: number;
  tokensRedeemed: number;
}

const COUNTER_DELTAS: Record<string, unknown> = {
  counters: { ballotsCast: 1, markersCast: 1, tokensRedeemed: 1 },
};

function nextCounters(data: Record<string, unknown>): ElectionCounters {
  const c = (data.counters ?? {}) as Partial<ElectionCounters>;
  return {
    ballotsCast: (c.ballotsCast ?? 0) + 1,
    markersCast: (c.markersCast ?? 0) + 1,
    tokensRedeemed: (c.tokensRedeemed ?? 0) + 1,
  };
}

/** Serialises the counters read-modify-write per election (a
 *  native atomic increment, when the backend offers one, runs
 *  inside the same lock; cross-instance atomicity comes from the
 *  increment primitive / the conditional PATCH at the bridge). */
const counterLocks = new Map<string, Promise<void>>();

async function withCounterLock<T>(
  electionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = counterLocks.get(electionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  counterLocks.set(electionId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (counterLocks.get(electionId) === tail) {
      counterLocks.delete(electionId);
    }
  }
}

type IncrementCapable = {
  incrementDoc?: (
    collection: string,
    id: string,
    deltas: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * F2 — turnout counters on the CASTING backend. The election doc
 * is re-read on the Supabase backend at write time and the bump is
 * computed from ITS current counters (never from the pre-cast
 * snapshot castBallot took for validation, so concurrent casts
 * lose no increments); the Firestore election doc is never touched
 * by a Supa cast. Resolution order: the G1 core seam's adapter
 * (the election doc's flipped home — getElectionOrThrow reads it
 * through the same adapter), then the G2 domain seam (the same
 * fs_elections table once the seams re-point at the one real
 * adapter). A native atomic incrementDoc is preferred where the
 * backend offers one; otherwise the bump is a read-modify-write
 * under the per-election lock. Any bridge error propagates (the
 * caller classifies it as post-write). When NEITHER backend holds
 * an election doc, the cast's configuration keeps the doc on
 * Firestore by design (the mixed G1-off/G2-on harness): there is
 * no Supa counters home, and the step is a no-op rather than
 * inventing a partial fs_elections row.
 */
async function supaBumpElectionCounters(electionId: string): Promise<void> {
  await withCounterLock(electionId, async () => {
    const core = await resolveElectionSupaAdapter();
    if (core) {
      const doc = await core.getDoc("elections", electionId);
      if (doc) {
        const { id: _docId, ...data } = doc;
        void _docId;
        const inc = (core as IncrementCapable).incrementDoc;
        if (typeof inc === "function") {
          await inc.call(core, "elections", electionId, COUNTER_DELTAS);
        } else {
          await core.updateDoc("elections", electionId, {
            counters: nextCounters(data),
          });
        }
        return;
      }
    }
    const domainDoc = await supaGetTopDoc("elections", electionId);
    if (domainDoc) {
      const adapter = getElectionSupaAdapter();
      const inc = (adapter as IncrementCapable | null)?.incrementDoc;
      if (adapter && typeof inc === "function") {
        await inc.call(adapter, "elections", electionId, COUNTER_DELTAS);
      } else {
        await supaUpdateTopDoc("elections", electionId, {
          counters: nextCounters(domainDoc.data),
        });
      }
      return;
    }
    // No election doc on either Supa backend: see the header note.
  });
}

/**
 * Supabase variant of the cast (used only when the 'elections'
 * surface is ON) — F3 semantics (BUILDOUT_AUDIT §5), replacing the
 * G2-era sequential version:
 *
 * - The backend is chosen ONCE (castBallot gates on
 *   electionsSupaEnabled()); everything inside this function runs
 *   through the STRICT seam functions from election-domain-supa,
 *   which throw on bridge error. The file-local per-operation
 *   fallback helpers (getSubDoc/setSubDoc/...) never operate
 *   inside a cast, so a cast can never split across backends.
 * - VALIDATION (unchanged order and codes): token existence /
 *   redemption / expiry -> bad_token 401 / poll_closed 410; poll
 *   window -> poll_closed 410; marker read-check fast path ->
 *   already_cast 409; choices -> invalid_choice 422. All of it is
 *   reads, so a bridge error here (token read included — it never
 *   degrades into bad_token) is PRE-WRITE infrastructure:
 *   castBallot may still fall back to the Firestore transaction
 *   as a whole.
 * - WRITE PHASE, in order, each step atomic at the seam:
 *   1. marker claim (insert-if-absent) — losing the claim is
 *      already_cast 409;
 *   2. token redemption (conditional update where redeemedAt is
 *      still null) — losing it is bad_token 401, with a
 *      best-effort release of the marker claim;
 *   3. the ballot write (randomUUID id, the exact anonymous
 *      payload of the Firestore path);
 *   4. counters, re-derived on the Supa election doc (F2).
 *   Once step 1's claim has landed, ANY later infrastructure
 *   failure is wrapped in SupaCastPostWriteError: no Firestore
 *   fallback, no further writes. ElectionError is never a
 *   fallback trigger at any point.
 */
async function castBallotSupa(
  _db: Db,
  electionId: string,
  input: CastBallotInput,
  election: Awaited<ReturnType<typeof getElectionOrThrow>>,
  certifiedUids: Set<string>,
  nowMillis: number,
  castDay: string,
): Promise<{ recorded: true; castDay: string }> {
  void _db;
  const pollOpenAt = millisOf(election.timetable.pollOpenAt);
  const pollCloseAt = millisOf(election.timetable.pollCloseAt);
  const tokenHash = hashBallotToken(input.token, electionId);
  const markerId = castMarkerId(electionId, input.uid);

  let writeLanded = false;
  try {
    // 1. Token must exist, be unredeemed, and be unexpired.
    const tokenDoc = await supaGetSubDoc(
      electionId,
      "eligibility_tokens",
      tokenHash,
    );
    if (!tokenDoc) {
      throw new ElectionError("bad_token", 401, "Invalid ballot token.");
    }
    const tokenData = tokenDoc.data;
    if (tokenData.redeemedAt != null) {
      throw new ElectionError("bad_token", 401, "Invalid ballot token.");
    }
    if (nowMillis > millisOf(tokenData.expiresAt)) {
      throw new ElectionError("poll_closed", 410, "The poll has closed.");
    }

    // Poll window, enforced here exactly as inside the transaction.
    if (
      election.status !== "poll_open" ||
      nowMillis < pollOpenAt ||
      nowMillis > pollCloseAt
    ) {
      throw new ElectionError("poll_closed", 410, "The poll is not open.");
    }

    // 2. Double-vote fast path against the marker (the atomic claim
    // in the write phase below is the authoritative check).
    const markerDoc = await supaGetSubDoc(
      electionId,
      "cast_markers",
      markerId,
    );
    if (markerDoc) {
      throw new ElectionError(
        "already_cast",
        409,
        "A ballot has already been cast for this voter.",
      );
    }

    // 3. Choice validation against the certified list.
    const choices = input.choices ?? [];
    const unique = new Set(choices);
    if (
      choices.length > election.seats ||
      unique.size !== choices.length ||
      !choices.every((c) => certifiedUids.has(c))
    ) {
      throw new ElectionError(
        "invalid_choice",
        422,
        "Ballot choices must be distinct certified candidates, at most the number of seats.",
      );
    }

    // ---- write phase ----
    // 1. Marker claim FIRST (atomic insert-if-absent).
    const claimed = await supaInsertSubDocIfAbsent(
      electionId,
      "cast_markers",
      markerId,
      {
        electionId,
        castDay,
        pollWindow: pollWindowId(electionId, pollOpenAt),
      },
    );
    if (!claimed) {
      throw new ElectionError(
        "already_cast",
        409,
        "A ballot has already been cast for this voter.",
      );
    }
    writeLanded = true;

    // 2. Token redemption SECOND (conditional: only while the
    // token is still unredeemed). Losing the race means the token
    // was redeemed by a concurrent cast — bad_token, and the
    // marker claim is released best-effort so this session is not
    // locked out by a cast that never happened.
    const redeemed = await supaUpdateSubDocIf(
      electionId,
      "eligibility_tokens",
      tokenHash,
      [["redeemedAt", "==", null]],
      {
        redeemedAt: tsFromMillis(nowMillis),
        redeemedDay: castDay,
      },
    );
    if (!redeemed) {
      try {
        await supaDeleteSubDoc(electionId, "cast_markers", markerId);
      } catch {
        // Best effort only: the claim release must never mask the
        // bad_token verdict or turn into another backend's write.
      }
      throw new ElectionError("bad_token", 401, "Invalid ballot token.");
    }

    // 3. Ballot write THIRD (randomUUID id, anonymous payload,
    // field-for-field the Firestore path's ballot).
    const ballotDoc = {
      electionId,
      choices: [...choices],
      castDay,
      isBlank: choices.length === 0,
    };
    await supaSetSubDoc(electionId, "ballots", randomUUID(), ballotDoc);

    // 4. Counters LAST, on the Supa election doc (F2).
    await supaBumpElectionCounters(electionId);
  } catch (err) {
    if (err instanceof ElectionError) throw err;
    if (writeLanded) {
      throw new SupaCastPostWriteError(
        `castBallot: Supabase infrastructure failure after a write landed for election ${electionId}; not falling back to Firestore`,
        err,
      );
    }
    // Pre-write infrastructure failure: rethrow so castBallot can
    // fall back to the Firestore transaction as a whole.
    throw err;
  }

  return { recorded: true, castDay };
}

export interface CastBallotInput {
  uid: string;
  token: string;
  choices: string[];
}

export async function castBallot(
  db: Db,
  electionId: string,
  input: CastBallotInput,
  nowMillis: number = Date.now(),
): Promise<{ recorded: true; castDay: string }> {
  const election = await getElectionOrThrow(db, electionId);
  const pollOpenAt = millisOf(election.timetable.pollOpenAt);
  const pollCloseAt = millisOf(election.timetable.pollCloseAt);
  const castDay = castDayBucket(nowMillis);

  const certified = await listCertifiedCandidates(db, electionId);
  const certifiedUids = new Set(certified.map((n) => n.candidateUid));

  if (electionsSupaEnabled()) {
    try {
      return await castBallotSupa(
        db,
        electionId,
        input,
        election,
        certifiedUids,
        nowMillis,
        castDay,
      );
    } catch (err) {
      if (err instanceof ElectionError) throw err;
      if (err instanceof SupaCastPostWriteError) {
        // F3: a Supa write already landed — surfacing the
        // infrastructure error is the only correct outcome. A
        // Firestore fallback would split the cast across backends.
        throw err;
      }
      // Supabase infrastructure error BEFORE any Supa write
      // landed (validation-phase bridge failure): fall back to
      // the Firestore transaction below as a WHOLE cast
      // (fallback contract).
    }
  }

  const tokenHash = hashBallotToken(input.token, electionId);
  const markerId = castMarkerId(electionId, input.uid);
  const tokenRef = tokensColl(db, electionId).doc(tokenHash);
  const markerRef = markersColl(db, electionId).doc(markerId);
  const ballotRef = ballotsColl(db, electionId).doc(randomUUID());
  const electionDocRef = db.collection("elections").doc(electionId);

  await db.runTransaction(async (tx: {
    get: (ref: unknown) => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
    set: (ref: unknown, data: Record<string, unknown>) => unknown;
    update: (ref: unknown, data: Record<string, unknown>) => unknown;
  }) => {
    // 1. Token must exist, be unredeemed, and be unexpired.
    const tokenSnap = await tx.get(tokenRef);
    if (!tokenSnap.exists) {
      throw new ElectionError("bad_token", 401, "Invalid ballot token.");
    }
    const tokenData = tokenSnap.data();
    if (tokenData.redeemedAt != null) {
      throw new ElectionError("bad_token", 401, "Invalid ballot token.");
    }
    if (nowMillis > millisOf(tokenData.expiresAt)) {
      throw new ElectionError("poll_closed", 410, "The poll has closed.");
    }

    // Poll window, enforced in the transaction itself (spec 6.3).
    if (
      election.status !== "poll_open" ||
      nowMillis < pollOpenAt ||
      nowMillis > pollCloseAt
    ) {
      throw new ElectionError("poll_closed", 410, "The poll is not open.");
    }

    // 2. Double-vote check against the marker (session identifies the
    // voter; the token authorises the ballot).
    const markerSnap = await tx.get(markerRef);
    if (markerSnap.exists) {
      throw new ElectionError(
        "already_cast",
        409,
        "A ballot has already been cast for this voter.",
      );
    }

    // 3. Choice validation against the certified list.
    const choices = input.choices ?? [];
    const unique = new Set(choices);
    if (
      choices.length > election.seats ||
      unique.size !== choices.length ||
      !choices.every((c) => certifiedUids.has(c))
    ) {
      throw new ElectionError(
        "invalid_choice",
        422,
        "Ballot choices must be distinct certified candidates, at most the number of seats.",
      );
    }

    // The ballot object is constructed field-by-field: exactly the
    // allowed schema, whatever extra fields the caller supplied.
    const ballotDoc = {
      electionId,
      choices: [...choices],
      castDay,
      isBlank: choices.length === 0,
    };
    tx.set(ballotRef, ballotDoc);

    // 4. Marker: proves this voter cast exactly once; proves nothing
    // about content.
    tx.set(markerRef, {
      electionId,
      castDay,
      pollWindow: pollWindowId(electionId, pollOpenAt),
    });

    // 5. Redeem the token.
    tx.update(tokenRef, {
      redeemedAt: tsFromMillis(nowMillis),
      redeemedDay: castDay,
    });

    // 6. Turnout counters (must always stay equal; see reconciliation).
    // F2 (Firestore arm): the counters are computed from the
    // IN-TRANSACTION read of the election doc, not from the
    // pre-cast snapshot above — the snapshot can be stale by the
    // time the transaction runs, and concurrent casts would lose
    // increments computed from it.
    const electionSnap = await tx.get(electionDocRef);
    const inTxElection = electionSnap.exists
      ? (electionSnap.data() as { counters?: ElectionCounters })
      : null;
    const counters = inTxElection?.counters ?? election.counters ?? {
      ballotsCast: 0,
      markersCast: 0,
      tokensRedeemed: 0,
    };
    tx.update(electionDocRef, {
      counters: {
        ballotsCast: counters.ballotsCast + 1,
        markersCast: counters.markersCast + 1,
        tokensRedeemed: counters.tokensRedeemed + 1,
      },
    });
  });

  return { recorded: true, castDay };
}

export interface TurnoutReport {
  rollSize: number;
  ballotsCast: number;
  markersCast: number;
  tokensRedeemed: number;
  counterBallots: number;
  counterMarkers: number;
  counterTokens: number;
  reconciled: boolean;
}

/**
 * Reconciliation read (spec 6.4): counters and collection counts only.
 * It never joins the collections - there is no join key to use.
 */
export async function getTurnout(
  db: Db,
  electionId: string,
): Promise<TurnoutReport> {
  const election = await getElectionOrThrow(db, electionId);
  const ballotDocs = await listSubDocs(db, electionId, "ballots");
  const markerDocs = await listSubDocs(db, electionId, "cast_markers");
  const tokenDocs = await listSubDocs(db, electionId, "eligibility_tokens");
  let redeemed = 0;
  for (const d of tokenDocs) {
    if (d.data.redeemedAt != null) redeemed += 1;
  }
  const counters = election.counters ?? {
    ballotsCast: 0,
    markersCast: 0,
    tokensRedeemed: 0,
  };
  const reconciled =
    ballotDocs.length === markerDocs.length &&
    markerDocs.length === redeemed &&
    counters.ballotsCast === ballotDocs.length &&
    counters.markersCast === markerDocs.length &&
    counters.tokensRedeemed === redeemed;
  return {
    rollSize: election.voterRoll.rollSize,
    ballotsCast: ballotDocs.length,
    markersCast: markerDocs.length,
    tokensRedeemed: redeemed,
    counterBallots: counters.ballotsCast,
    counterMarkers: counters.markersCast,
    counterTokens: counters.tokensRedeemed,
    reconciled,
  };
}

/** RO-only "has this member cast" check, derived from marker existence. */
export async function hasCast(
  db: Db,
  electionId: string,
  uid: string,
): Promise<boolean> {
  const doc = await getSubDoc(
    db,
    electionId,
    "cast_markers",
    castMarkerId(electionId, uid),
  );
  return doc !== null;
}

export { writeElectionAudit };
