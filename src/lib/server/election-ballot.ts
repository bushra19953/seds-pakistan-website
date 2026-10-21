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

  const markerRef = markersColl(db, electionId).doc(castMarkerId(electionId, uid));
  const markerSnap = await markerRef.get();
  if (markerSnap.exists) {
    throw new ElectionError(
      "already_cast",
      409,
      "A ballot has already been cast for this voter.",
    );
  }

  const issuanceRef = issuanceColl(db, electionId).doc(tokenIssuanceId(electionId, uid));
  const issuanceSnap = await issuanceRef.get();
  if (issuanceSnap.exists) {
    const prevHash = issuanceSnap.data().tokenHash as string;
    const prevTokenSnap = await tokensColl(db, electionId).doc(prevHash).get();
    if (prevTokenSnap.exists && prevTokenSnap.data().redeemedAt == null) {
      if (!opts.reissue) {
        throw new ElectionError(
          "token_already_issued",
          409,
          "A live ballot token has already been issued to this voter.",
        );
      }
      // Reissue invalidates the previous token doc (spec 3.4(a)).
      await tokensColl(db, electionId).doc(prevHash).delete();
    }
  }

  const token = generateBallotToken();
  const tokenHash = hashBallotToken(token, electionId);
  await tokensColl(db, electionId)
    .doc(tokenHash)
    .set({
      electionId,
      issuedAt: tsFromMillis(nowMillis),
      expiresAt: tsFromMillis(pollCloseAt),
      redeemedAt: null,
      redeemedDay: null,
    });
  await issuanceRef.set({ tokenHash, issuedAt: tsFromMillis(nowMillis) });

  // The plaintext token is returned ONCE to the caller (the route) over
  // the authenticated response. It is never stored, never logged, and
  // never written into an audit payload.
  return { token };
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
  const ballotsSnap = await ballotsColl(db, electionId).get();
  const markersSnap = await markersColl(db, electionId).get();
  const tokensSnap = await tokensColl(db, electionId).get();
  let redeemed = 0;
  for (const d of tokensSnap.docs) {
    if (d.data().redeemedAt != null) redeemed += 1;
  }
  const counters = election.counters ?? {
    ballotsCast: 0,
    markersCast: 0,
    tokensRedeemed: 0,
  };
  const reconciled =
    ballotsSnap.size === markersSnap.size &&
    markersSnap.size === redeemed &&
    counters.ballotsCast === ballotsSnap.size &&
    counters.markersCast === markersSnap.size &&
    counters.tokensRedeemed === redeemed;
  return {
    rollSize: election.voterRoll.rollSize,
    ballotsCast: ballotsSnap.size,
    markersCast: markersSnap.size,
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
  const snap = await markersColl(db, electionId)
    .doc(castMarkerId(electionId, uid))
    .get();
  return snap.exists;
}

export { writeElectionAudit };
