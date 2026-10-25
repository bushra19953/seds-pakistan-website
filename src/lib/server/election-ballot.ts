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
  supaDeleteSubDoc,
  supaGetSubDoc,
  supaListSubDocs,
  supaSetSubDoc,
  supaUpdateSubDoc,
} from "./election-domain-supa";

function tokensColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("eligibility_tokens");
}
function markersColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("cast_markers");
}
function ballotsColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("ballots");
}
function issuanceColl(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("token_issuance");
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

async function updateSubDoc(
  db: Db,
  electionId: string,
  sub: BallotSub,
  docId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaUpdateSubDoc(electionId, sub, docId, updates);
      return;
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  await subColl(db, electionId, sub).doc(docId).update(updates);
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
 * Supabase variant of the cast (used only when the 'elections'
 * surface is ON). The adapter has no transaction primitive, so the
 * four writes run sequentially; the VALIDATION ORDER and every error
 * are identical to the transactional path below: token existence /
 * redemption / expiry, poll window, double-vote marker, choice
 * validation, then ballot + marker + token redemption + counters.
 * Atomicity is the one property that differs (adapter read-modify-
 * write race, noted in the adapter contract); a Supabase
 * infrastructure error rethrows so castBallot can fall back to the
 * Firestore transaction BEFORE any write has been attempted on the
 * read/validation steps. ElectionError is never a fallback trigger.
 */
async function castBallotSupa(
  db: Db,
  electionId: string,
  input: CastBallotInput,
  election: Awaited<ReturnType<typeof getElectionOrThrow>>,
  certifiedUids: Set<string>,
  nowMillis: number,
  castDay: string,
): Promise<{ recorded: true; castDay: string }> {
  const pollOpenAt = millisOf(election.timetable.pollOpenAt);
  const pollCloseAt = millisOf(election.timetable.pollCloseAt);
  const tokenHash = hashBallotToken(input.token, electionId);
  const markerId = castMarkerId(electionId, input.uid);

  // 1. Token must exist, be unredeemed, and be unexpired.
  const tokenDoc = await getSubDoc(db, electionId, "eligibility_tokens", tokenHash);
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

  // 2. Double-vote check against the marker.
  const markerDoc = await getSubDoc(db, electionId, "cast_markers", markerId);
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

  const ballotDoc = {
    electionId,
    choices: [...choices],
    castDay,
    isBlank: choices.length === 0,
  };
  await setSubDoc(db, electionId, "ballots", randomUUID(), ballotDoc);
  await setSubDoc(db, electionId, "cast_markers", markerId, {
    electionId,
    castDay,
    pollWindow: pollWindowId(electionId, pollOpenAt),
  });
  await updateSubDoc(db, electionId, "eligibility_tokens", tokenHash, {
    redeemedAt: tsFromMillis(nowMillis),
    redeemedDay: castDay,
  });
  const counters = election.counters ?? {
    ballotsCast: 0,
    markersCast: 0,
    tokensRedeemed: 0,
  };
  await db.collection("elections").doc(electionId).update({
    counters: {
      ballotsCast: counters.ballotsCast + 1,
      markersCast: counters.markersCast + 1,
      tokensRedeemed: counters.tokensRedeemed + 1,
    },
  });

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
      // Supabase infrastructure error: fall back to the Firestore
      // transaction below (fallback contract).
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
    const counters = election.counters ?? {
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
