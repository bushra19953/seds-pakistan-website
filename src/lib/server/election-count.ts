/**
 * Count, tie-by-lot, declaration, challenges (spec Sections 3.5, 4
 * routes 13-15 and 17, 6.4, 6.5, 6.7).
 *
 * Count integrity: the count opens only after poll close, only with 2
 * non-candidate tellers appointed, and only when the turnout
 * reconciliation passes (ballots == markers == redeemed tokens ==
 * counters). There is no override in v1; a disagreement blocks the
 * count and raises an audit-logged integrity flag.
 *
 * Tie-by-lot: the draw happens OFFLINE (Sec 7.8) in the presence of the
 * tied candidates or their observers. This module records the event;
 * it never generates a draw. Declaration refuses to run while a
 * cutoff tie has no completed tie_lots record resolving it.
 *
 * Declaration partial-failure rule (route 15): if the Board register
 * port fails, the declaration still stands (it is the RO's
 * constitutional act); the writeback is marked failed with a retry
 * action, audit-logged and surfaced, never hidden.
 */

import type {
  CountRecord,
  ElectionResult,
  TieLotRecord,
  TieLotWitness,
} from "@/types/elections";
import {
  allocateSeats,
  applyTieLotWinner,
  tallyBallots,
  type SeatAllocation,
} from "@/lib/elections/count";
import { certificateDeadline, challengeWindowClose } from "@/lib/elections/timetable";
import { buildElectionCertificatePdf } from "@/lib/election-certificate-pdf";
import { ElectionError, type ElectionPorts } from "./election-ports";
import {
  type Db,
  tsFromMillis,
  serverTimestamp,
  millisOf,
  getElectionOrThrow,
  electionRef,
  assertRo,
} from "./election-db";
import { writeElectionAudit } from "./election-audit";
import {
  electionsSupaEnabled,
  supaAddSubDoc,
  supaGetSubDoc,
  supaListSubDocs,
  supaSetSubDoc,
  supaUpdateSubDoc,
  type SupaWhereClause,
} from "./election-domain-supa";
import { getTurnout } from "./election-ballot";
import { listCertifiedCandidates, listNominations } from "./election-nominations";
import { isOnFrozenRoll } from "./election-roll";

// ---------------------------------------------------------------------------
// Data-access helpers: the ONLY branch point between Firestore and
// Supabase for the count subcollections (officials, count_record,
// result, tie_lots, challenges, result_amendments, and the ballots
// read in openCount -> fs_group_<name> tables). Stored shapes are
// byte-identical; timestamp fields per collection (officials:
// appointedAt; count_record: openedAt, signedOffAt, signedOffBy.roAt,
// signedOffBy.tellersAt; result: declaredAt, publishedAt,
// elected[].termStart/termEnd, certificate.*, governorRegisterWriteback
// .writtenAt, lifecycleNotification.sentAt; tie_lots: drawnAt,
// recordedAt; challenges: filedAt, roRuling.ruledAt; result_amendments:
// recordedAt) are converted by the seam (Timestamp -> ISO on write,
// ISO -> Timestamp-shaped object on read), so millisOf() in the
// declaration path sees the same millis. Flag OFF / unconfigured /
// any Supabase error -> Firestore helper.
// ---------------------------------------------------------------------------

type CountSub =
  | "officials"
  | "count_record"
  | "result"
  | "tie_lots"
  | "challenges"
  | "result_amendments"
  | "ballots";

interface CntDoc {
  id: string;
  data: Record<string, unknown>;
}

function cntColl(db: Db, electionId: string, sub: CountSub) {
  return db.collection("elections").doc(electionId).collection(sub);
}

async function listCntDocs(
  db: Db,
  electionId: string,
  sub: CountSub,
  where?: SupaWhereClause[],
): Promise<CntDoc[]> {
  if (electionsSupaEnabled()) {
    try {
      return await supaListSubDocs(electionId, sub, where);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  let query = cntColl(db, electionId, sub);
  for (const [field, op, value] of where ?? []) {
    query = query.where(field, op, value);
  }
  const snap = await query.get();
  return snap.docs.map(
    (d: { id: string; data: () => Record<string, unknown> }) => ({
      id: d.id,
      data: d.data(),
    }),
  );
}

async function getCntDoc(
  db: Db,
  electionId: string,
  sub: CountSub,
  docId: string,
): Promise<CntDoc | null> {
  if (electionsSupaEnabled()) {
    try {
      return await supaGetSubDoc(electionId, sub, docId);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await cntColl(db, electionId, sub).doc(docId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() as Record<string, unknown> };
}

async function setCntDoc(
  db: Db,
  electionId: string,
  sub: CountSub,
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
  await cntColl(db, electionId, sub).doc(docId).set(data);
}

async function updateCntDoc(
  db: Db,
  electionId: string,
  sub: CountSub,
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
  await cntColl(db, electionId, sub).doc(docId).update(updates);
}

async function addCntDoc(
  db: Db,
  electionId: string,
  sub: CountSub,
  data: Record<string, unknown>,
): Promise<string> {
  if (electionsSupaEnabled()) {
    try {
      return await supaAddSubDoc(electionId, sub, data);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const ref = cntColl(db, electionId, sub).doc();
  await ref.set(data);
  return ref.id as string;
}

// ---------------------------------------------------------------------------
// Officials: tellers and observers (Sec 7.7)
// ---------------------------------------------------------------------------

export async function appointTeller(
  db: Db,
  electionId: string,
  callerUid: string,
  teller: { uid: string; name: string },
  nowMillis: number = Date.now(),
): Promise<void> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  if (teller.uid === election.returningOfficerUid) {
    throw new ElectionError("teller_is_ro", 422, "The Returning Officer cannot be a teller.");
  }
  const nominations = await listNominations(db, electionId);
  if (nominations.some((n) => n.candidateUid === teller.uid && n.status !== "withdrawn")) {
    throw new ElectionError(
      "teller_is_candidate",
      422,
      "A candidate cannot be a teller (Sec 7.7: tellers are non-candidates).",
    );
  }
  const tellerDocs = await listCntDocs(db, electionId, "officials", [
    ["officialRole", "==", "teller"],
  ]);
  const existing = tellerDocs.filter((d) => d.id !== teller.uid);
  if (existing.length >= 2) {
    throw new ElectionError("tellers_full", 409, "Two tellers are already appointed.");
  }
  await setCntDoc(db, electionId, "officials", teller.uid, {
      uid: teller.uid,
      name: teller.name,
      officialRole: "teller",
      appointedByUid: callerUid,
      forCandidateUid: null,
      isCandidate: false,
      appointedAt: tsFromMillis(nowMillis),
    });
  await writeElectionAudit(db, {
    action: "election.teller_appoint",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { tellerUid: teller.uid },
  });
}

export async function registerObserver(
  db: Db,
  electionId: string,
  callerUid: string,
  observer: { uid: string; name: string; forCandidateUid: string },
  nowMillis: number = Date.now(),
): Promise<void> {
  const election = await getElectionOrThrow(db, electionId);
  // Observers are appointed by the candidate they observe for (Sec 7.7:
  // each candidate may appoint 1 observer with a tally-only view).
  if (callerUid !== observer.forCandidateUid) {
    throw new ElectionError(
      "observer_appointer",
      403,
      "Only the candidate may appoint their own observer.",
    );
  }
  const certified = await listCertifiedCandidates(db, electionId);
  if (!certified.some((n) => n.candidateUid === observer.forCandidateUid)) {
    throw new ElectionError(
      "observer_for_non_candidate",
      422,
      "Observers can only be registered for a certified candidate.",
    );
  }
  const observerDocs = await listCntDocs(db, electionId, "officials", [
    ["officialRole", "==", "observer"],
  ]);
  for (const d of observerDocs) {
    if (d.data.forCandidateUid === observer.forCandidateUid) {
      throw new ElectionError(
        "observer_exists",
        409,
        "This candidate already has an observer (1 per candidate, Sec 7.7).",
      );
    }
  }
  await setCntDoc(db, electionId, "officials", observer.uid, {
      uid: observer.uid,
      name: observer.name,
      officialRole: "observer",
      appointedByUid: callerUid,
      forCandidateUid: observer.forCandidateUid,
      isCandidate: observer.uid === observer.forCandidateUid,
      appointedAt: tsFromMillis(nowMillis),
    });
  await writeElectionAudit(db, {
    action: "election.observer_register",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { observerUid: observer.uid, forCandidateUid: observer.forCandidateUid },
  });
}

export async function listTellers(db: Db, electionId: string): Promise<string[]> {
  const docs = await listCntDocs(db, electionId, "officials", [
    ["officialRole", "==", "teller"],
  ]);
  return docs.map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

export async function openCount(
  db: Db,
  electionId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<CountRecord> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  if (election.status !== "poll_closed") {
    throw new ElectionError(
      "poll_not_closed",
      409,
      "The count opens only after the poll has closed.",
    );
  }

  // RO-conflict rule, enforced again at count open (spec 1.1 item 1).
  const certified = await listCertifiedCandidates(db, electionId);
  if (certified.some((n) => n.candidateUid === election.returningOfficerUid)) {
    throw new ElectionError(
      "ro_is_candidate",
      422,
      "A certified candidate is the Returning Officer; the count cannot open.",
    );
  }

  const tellers = await listTellers(db, electionId);
  if (tellers.length !== 2) {
    throw new ElectionError(
      "tellers_required",
      409,
      "Exactly 2 tellers must be appointed before the count opens (Sec 7.7).",
    );
  }

  const turnout = await getTurnout(db, electionId);
  if (!turnout.reconciled) {
    await writeElectionAudit(db, {
      action: "election.count_integrity_flag",
      actorUid: callerUid,
      targetUidOrResource: `election:${electionId}`,
      payload: { turnout, at: nowMillis },
    });
    throw new ElectionError(
      "turnout_not_reconciled",
      409,
      "Turnout does not reconcile (ballots, markers, redeemed tokens and counters disagree). The count is blocked; there is no override.",
    );
  }

  const ballotDocs = await listCntDocs(db, electionId, "ballots");
  const ballots = ballotDocs.map((d) => {
    const data = d.data;
    return {
      choices: (data.choices as string[]) ?? [],
      isBlank: data.isBlank === true,
    };
  });
  const certifiedUids = certified.map((n) => n.candidateUid);
  const tally = tallyBallots(ballots, certifiedUids, election.seats);
  const allocation = allocateSeats(tally.tallies, election.seats);

  const record: Record<string, unknown> = {
    openedByUid: callerUid,
    openedAt: tsFromMillis(nowMillis),
    tellerUids: tellers,
    ballotsCounted: tally.ballotsCounted,
    blankBallots: tally.blankBallots,
    invalidBallots: tally.invalidBallots,
    tallies: tally.tallies,
    turnout: {
      rollSize: turnout.rollSize,
      ballotsCast: turnout.ballotsCast,
      markersCast: turnout.markersCast,
      tokensRedeemed: turnout.tokensRedeemed,
      reconciled: turnout.reconciled,
    },
    cutoffTie: allocation.cutoffTie,
    tieLotIds: [],
    signedOffBy: { roUid: null, roAt: null, tellerUids: [], tellersAt: null },
    signedOffAt: null,
    status: allocation.cutoffTie ? "tie_pending" : "tallied",
  };
  await setCntDoc(db, electionId, "count_record", "main", record);
  await electionRef(db, electionId).update({
    status: allocation.cutoffTie ? "tie_pending" : "counted",
    updatedAt: serverTimestamp(),
  });
  await writeElectionAudit(db, {
    action: "election.count_open",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: {
      ballotsCounted: tally.ballotsCounted,
      blankBallots: tally.blankBallots,
      invalidBallots: tally.invalidBallots,
      cutoffTie: allocation.cutoffTie,
      at: nowMillis,
    },
  });

  const finalDoc = await getCntDoc(db, electionId, "count_record", "main");
  return finalDoc?.data as CountRecord;
}

export async function getCountRecord(
  db: Db,
  electionId: string,
): Promise<CountRecord | null> {
  const doc = await getCntDoc(db, electionId, "count_record", "main");
  return doc ? (doc.data as CountRecord) : null;
}

export async function signOffCount(
  db: Db,
  electionId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<CountRecord> {
  const election = await getElectionOrThrow(db, electionId);
  const record = await getCountRecord(db, electionId);
  if (!record) {
    throw new ElectionError("count_not_open", 409, "The count has not been opened.");
  }
  if (record.status === "signed_off") {
    throw new ElectionError("count_already_signed_off", 409, "The count is already signed off.");
  }
  const isRo = callerUid === election.returningOfficerUid;
  const isTeller = record.tellerUids.includes(callerUid);
  if (!isRo && !isTeller) {
    throw new ElectionError(
      "not_count_official",
      403,
      "Only the Returning Officer and the appointed tellers sign off the count.",
    );
  }

  const signedOffBy = { ...record.signedOffBy };
  if (isRo) {
    signedOffBy.roUid = callerUid;
    signedOffBy.roAt = tsFromMillis(nowMillis);
  } else {
    if (!signedOffBy.tellerUids.includes(callerUid)) {
      signedOffBy.tellerUids = [...signedOffBy.tellerUids, callerUid];
    }
    if (record.tellerUids.every((t) => signedOffBy.tellerUids.includes(t))) {
      signedOffBy.tellersAt = tsFromMillis(nowMillis);
    }
  }

  const complete =
    signedOffBy.roUid !== null &&
    record.tellerUids.every((t) => signedOffBy.tellerUids.includes(t));

  await updateCntDoc(db, electionId, "count_record", "main", {
    signedOffBy,
    status: complete ? "signed_off" : record.status,
    signedOffAt: complete ? tsFromMillis(nowMillis) : record.signedOffAt,
  });
  await writeElectionAudit(db, {
    action: "election.count_sign_off",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { role: isRo ? "returning_officer" : "teller", complete, at: nowMillis },
  });

  const finalDoc = await getCntDoc(db, electionId, "count_record", "main");
  return finalDoc?.data as CountRecord;
}

// ---------------------------------------------------------------------------
// Tie-by-lot record
// ---------------------------------------------------------------------------

export interface RecordTieLotInput {
  method: string;
  witnesses: TieLotWitness[];
  outcomeWinningCandidateUid: string;
  drawnAtMillis: number;
  evidence: { driveFileId: string; driveLink: string; sha256: string } | null;
}

export async function recordTieLot(
  db: Db,
  electionId: string,
  callerUid: string,
  input: RecordTieLotInput,
  nowMillis: number = Date.now(),
): Promise<TieLotRecord> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  const record = await getCountRecord(db, electionId);
  if (!record || !record.cutoffTie) {
    throw new ElectionError(
      "no_cutoff_tie",
      409,
      "There is no unresolved cutoff tie on this election's count.",
    );
  }
  const tie = record.cutoffTie;
  if (!tie.tiedCandidateUids.includes(input.outcomeWinningCandidateUid)) {
    throw new ElectionError(
      "lot_winner_not_tied",
      422,
      "The lot outcome winner must be one of the tied candidates.",
    );
  }
  if (!input.method || input.method.trim().length === 0) {
    throw new ElectionError(
      "lot_method_required",
      422,
      "The lot method is recorded data (Sec 7.8) and is required.",
    );
  }

  // Presence: every tied candidate, or their appointed observer, must
  // have a witness entry with presenceConfirmed true (Sec 7.8).
  const officialDocs = await listCntDocs(db, electionId, "officials", [
    ["officialRole", "==", "observer"],
  ]);
  const observerFor = new Map<string, string>();
  for (const d of officialDocs) {
    observerFor.set(d.id, d.data.forCandidateUid as string);
  }
  for (const tiedUid of tie.tiedCandidateUids) {
    const present = input.witnesses.some((w) => {
      if (!w.presenceConfirmed) return false;
      if (w.capacity === "candidate" && w.uid === tiedUid) return true;
      if (w.capacity === "observer" && w.uid && observerFor.get(w.uid) === tiedUid) {
        return true;
      }
      return false;
    });
    if (!present) {
      throw new ElectionError(
        "lot_presence_unconfirmed",
        422,
        `No confirmed presence for tied candidate ${tiedUid} (or their observer); the lot record cannot be accepted (Sec 7.8).`,
      );
    }
  }

  const lotDoc: Record<string, unknown> = {
    electionId,
    reason: "tie at second-seat cutoff",
    tiedCandidateUids: tie.tiedCandidateUids,
    votesEach: tie.votesEach,
    method: input.method,
    drawnByUid: callerUid,
    drawnAt: tsFromMillis(input.drawnAtMillis),
    witnesses: input.witnesses,
    outcomeWinningCandidateUid: input.outcomeWinningCandidateUid,
    evidence: input.evidence,
    recordedByUid: callerUid,
    recordedAt: tsFromMillis(nowMillis),
  };
  const lotId = await addCntDoc(db, electionId, "tie_lots", lotDoc);

  // Resolve one contested seat in the count record.
  const current: SeatAllocation = {
    elected: [],
    cutoffTie: tie,
    seatsPendingLot: tie.seatsContested,
  };
  const next = applyTieLotWinner(current, input.outcomeWinningCandidateUid);
  const tieLotIds = [
    ...(((record as unknown as Record<string, unknown>).tieLotIds as string[]) ?? []),
    lotId,
  ];
  await updateCntDoc(db, electionId, "count_record", "main", {
    cutoffTie: next.cutoffTie,
    tieLotIds,
    status:
      record.status === "signed_off"
        ? "signed_off"
        : next.cutoffTie
          ? "tie_pending"
          : "tallied",
  });
  if (!next.cutoffTie) {
    await electionRef(db, electionId).update({
      status: "counted",
      updatedAt: serverTimestamp(),
    });
  }
  await writeElectionAudit(db, {
    action: "election.tie_lot_record",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: {
      tieLotId: lotId,
      winnerUid: input.outcomeWinningCandidateUid,
      method: input.method,
    },
  });

  return { id: lotId, ...lotDoc } as unknown as TieLotRecord;
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

export async function declareResult(
  db: Db,
  ports: ElectionPorts,
  electionId: string,
  callerUid: string,
  opts: { verificationBaseUrl?: string } = {},
  nowMillis: number = Date.now(),
): Promise<ElectionResult> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  const record = await getCountRecord(db, electionId);
  if (!record || record.status !== "signed_off") {
    throw new ElectionError(
      "count_not_signed_off",
      409,
      "The result can only be declared after the count is signed off by the RO and both tellers.",
    );
  }
  if (record.cutoffTie) {
    throw new ElectionError(
      "tie_unresolved",
      409,
      "Declaration is blocked: a cutoff tie exists with no completed tie-by-lot record resolving it.",
    );
  }
  const existing = await getCntDoc(db, electionId, "result", "main");
  if (existing) {
    throw new ElectionError("already_declared", 409, "This election is already declared.");
  }

  const certified = await listCertifiedCandidates(db, electionId);
  const names = new Map(certified.map((n) => [n.candidateUid, n.candidateName]));

  // Rebuild the allocation from the signed-off tallies plus lot winners.
  let allocation = allocateSeats(record.tallies, election.seats);
  const tieLotIds =
    ((record as unknown as Record<string, unknown>).tieLotIds as string[]) ?? [];
  for (const lotId of tieLotIds) {
    const lotDoc = await getCntDoc(db, electionId, "tie_lots", lotId);
    if (lotDoc && allocation.cutoffTie) {
      allocation = applyTieLotWinner(
        allocation,
        lotDoc.data.outcomeWinningCandidateUid as string,
      );
    }
  }
  const electedUids = allocation.elected;

  const countEndMillis = record.signedOffAt
    ? millisOf(record.signedOffAt)
    : nowMillis;
  const certDeadline = certificateDeadline(countEndMillis);

  // Board register writeback (Phase 2 port). Failure marks the
  // writeback failed; the declaration itself stands (route 15 rule).
  const governorIds: string[] = [];
  const termEnds = new Map<string, number | null>();
  let writebackError: string | null = null;
  for (const uid of electedUids) {
    try {
      const res = await ports.board.writeMemberGovernor({
        electionId,
        candidateUid: uid,
        votes: record.tallies[uid] ?? 0,
        termStartMillis: nowMillis,
      });
      governorIds.push(res.governorId);
      termEnds.set(uid, res.termEndMillis);
    } catch (err) {
      writebackError = err instanceof Error ? err.message : String(err);
    }
  }
  const writebackStatus = writebackError
    ? "failed"
    : governorIds.length === electedUids.length
      ? "written"
      : "pending";

  // Lifecycle notification (Phase 2 port).
  let lifecycleStatus: "sent" | "failed" = "sent";
  try {
    await ports.lifecycle.notifySeatsFilled({
      electionId,
      electedUids,
      termStartMillis: nowMillis,
    });
  } catch {
    lifecycleStatus = "failed";
  }

  // Decision register (Workstream A port, fallback local record).
  let decisionRecordId: string | null = null;
  try {
    const dec = await ports.decisions.recordDecision({
      kind: "member_governor_election_result",
      title: `Result declared: ${election.title}`,
      payload: { electionId, electedUids },
    });
    decisionRecordId = dec.decisionRecordId;
  } catch {
    decisionRecordId = null;
  }

  // Registrar filing obligation (30 days, row 5.21 filing flag).
  const filing = await ports.compliance.registerObligation({
    key: `election:${electionId}:registrar_filing`,
    kind: "registrar_filing_governors",
    title: `File updated list of Governors with the Registrar: ${election.title}`,
    dueAtMillis: nowMillis + 30 * 24 * 60 * 60 * 1000,
    ownerRole: "national_general_secretary",
    electionId,
  });

  // Certificate PDF + Drive storage (governance kind, via port).
  const certData = {
    electionId,
    electionTitle: election.title,
    seats: election.seats,
    elected: electedUids.map((uid) => ({
      candidateUid: uid,
      name: names.get(uid) ?? uid,
      votes: record.tallies[uid] ?? 0,
    })),
    tallies: record.tallies,
    candidateNames: Object.fromEntries(names),
    tieLotId: tieLotIds.length > 0 ? tieLotIds[tieLotIds.length - 1] : null,
    returningOfficerName: election.returningOfficerName,
    returningOfficerUid: election.returningOfficerUid,
    declaredAtMillis: nowMillis,
    verificationUrl: `${opts.verificationBaseUrl ?? "https://sedspakistan.live"}/elections/${electionId}`,
  };
  const cert = await buildElectionCertificatePdf(certData);
  let driveFileId = "";
  let driveLink = "";
  try {
    const stored = await ports.drive.storeElectionCertificate({
      electionId,
      fileName: `election-certificate-${electionId}.pdf`,
      pdfBytes: cert.pdfBytes,
      sha256: cert.sha256,
    });
    driveFileId = stored.driveFileId;
    driveLink = stored.driveLink;
  } catch (err) {
    await writeElectionAudit(db, {
      action: "election.certificate_store_failed",
      actorUid: callerUid,
      targetUidOrResource: `election:${electionId}`,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  const result: Record<string, unknown> = {
    declaredByUid: callerUid,
    declaredAt: tsFromMillis(nowMillis),
    elected: electedUids.map((uid) => ({
      candidateUid: uid,
      name: names.get(uid) ?? uid,
      votes: record.tallies[uid] ?? 0,
      seatCategory: "member_elected",
      termStart: tsFromMillis(nowMillis),
      termEnd:
        termEnds.get(uid) != null ? tsFromMillis(termEnds.get(uid) as number) : null,
    })),
    totals: {
      tallies: record.tallies,
      ballotsCounted: record.ballotsCounted,
      blankBallots: record.blankBallots,
      invalidBallots: record.invalidBallots,
    },
    tieLotId: certData.tieLotId,
    certificate: {
      driveFileId,
      driveLink,
      sha256: cert.sha256,
      issuedAt: tsFromMillis(nowMillis),
      deliveredTo: ["national_general_secretary", "board_of_governors", "founder"],
      deliveryDeadlineAt: tsFromMillis(certDeadline),
    },
    governorRegisterWriteback: {
      status: writebackStatus,
      writtenAt: writebackStatus === "written" ? tsFromMillis(nowMillis) : null,
      governorIds,
      error: writebackError,
    },
    lifecycleNotification: {
      status: lifecycleStatus,
      sentAt: lifecycleStatus === "sent" ? tsFromMillis(nowMillis) : null,
    },
    decisionRecordId,
    registrarFilingObligationId: filing.obligationId,
    publishedAt: tsFromMillis(nowMillis),
  };
  await setCntDoc(db, electionId, "result", "main", result);

  // RO term ends at declaration (Sec 01 C11). Stamp it and record the
  // term end in role_history through the Phase 1 port. The narrow
  // challenge-only authority (spec 12.2 DEFAULT) runs to window close.
  const timetable = {
    ...election.timetable,
    certificateDeadlineAt: tsFromMillis(certDeadline),
    challengeWindowClosesAt: tsFromMillis(challengeWindowClose(nowMillis)),
  };
  await electionRef(db, electionId).update({
    status: "declared",
    roTermEndsAt: tsFromMillis(nowMillis),
    timetable,
    complianceObligationIds: {
      ...election.complianceObligationIds,
      registrarFiling: filing.obligationId,
    },
    updatedAt: serverTimestamp(),
  });
  await ports.roleHistory.recordRoleEvent({
    uid: election.returningOfficerUid,
    roleKey: "returning_officer",
    action: "change",
    previousRole: "returning_officer",
    newRole: "returning_officer",
    actorUid: callerUid,
    reason: `Returning Officer term ended at result declaration for election "${election.title}" (${electionId}); roTermEndsAt stamped. Challenge-only authority runs to the challenge window close (spec 12.2 default).`,
    source: "admin_assign",
  });
  await writeElectionAudit(db, {
    action: "election.declare",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: {
      electedUids,
      tieLotId: certData.tieLotId,
      writebackStatus,
      certificateDeadlineAt: certDeadline,
      at: nowMillis,
    },
  });

  const finalDoc = await getCntDoc(db, electionId, "result", "main");
  return finalDoc?.data as ElectionResult;
}

/** Retry a failed Board register writeback from the RO console. */
export async function retryGovernorWriteback(
  db: Db,
  ports: ElectionPorts,
  electionId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<ElectionResult> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  const resultDoc = await getCntDoc(db, electionId, "result", "main");
  if (!resultDoc) {
    throw new ElectionError("result_not_found", 404, "No declared result for this election.");
  }
  const result = resultDoc.data as ElectionResult;
  if (result.governorRegisterWriteback.status !== "failed") {
    return result;
  }
  const governorIds: string[] = [];
  let error: string | null = null;
  for (const e of result.elected) {
    try {
      const res = await ports.board.writeMemberGovernor({
        electionId,
        candidateUid: e.candidateUid,
        votes: e.votes,
        termStartMillis: millisOf(result.declaredAt),
      });
      governorIds.push(res.governorId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const status = error ? "failed" : "written";
  await updateCntDoc(db, electionId, "result", "main", {
    governorRegisterWriteback: {
      status,
      writtenAt: status === "written" ? tsFromMillis(nowMillis) : null,
      governorIds,
      error,
    },
  });
  await writeElectionAudit(db, {
    action: "election.register_writeback_retry",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { status, error },
  });
  const finalDoc = await getCntDoc(db, electionId, "result", "main");
  return finalDoc?.data as ElectionResult;
}

export async function getResult(
  db: Db,
  electionId: string,
): Promise<ElectionResult | null> {
  const doc = await getCntDoc(db, electionId, "result", "main");
  return doc ? (doc.data as ElectionResult) : null;
}

// ---------------------------------------------------------------------------
// Challenges (spec 6.7; window DEFAULT 7 days, spec 12.2)
// ---------------------------------------------------------------------------

export async function fileChallenge(
  db: Db,
  electionId: string,
  challengerUid: string,
  grounds: string,
  nowMillis: number = Date.now(),
): Promise<{ challengeId: string; withinWindow: boolean }> {
  const election = await getElectionOrThrow(db, electionId);
  if (election.status !== "declared" && election.status !== "challenge_window") {
    throw new ElectionError(
      "result_not_declared",
      409,
      "Challenges can only be filed after the result is declared.",
    );
  }
  if (!(await isOnFrozenRoll(db, electionId, challengerUid))) {
    throw new ElectionError(
      "challenger_not_on_roll",
      403,
      "Only members on the frozen roll may file a challenge.",
    );
  }
  if (!grounds || grounds.trim().length === 0 || grounds.length > 2000) {
    throw new ElectionError(
      "grounds_invalid",
      422,
      "Grounds are required and capped at 2000 characters.",
    );
  }
  const closeAt =
    election.timetable.challengeWindowClosesAt != null
      ? millisOf(election.timetable.challengeWindowClosesAt)
      : null;
  const withinWindow = closeAt !== null && nowMillis <= closeAt;

  const challengeId = await addCntDoc(db, electionId, "challenges", {
    electionId,
    challengerUid,
    grounds,
    filedAt: tsFromMillis(nowMillis),
    withinWindow,
    status: "filed",
    roRuling: null,
  });
  await writeElectionAudit(db, {
    action: "election.challenge_file",
    actorUid: challengerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { challengeId, withinWindow },
  });
  return { challengeId, withinWindow };
}

export async function ruleChallenge(
  db: Db,
  electionId: string,
  challengeId: string,
  callerUid: string,
  input: {
    ruling: string;
    effectOnResult: "none" | "result_amended" | "election_voided";
    upheld: boolean;
  },
  nowMillis: number = Date.now(),
): Promise<void> {
  const election = await getElectionOrThrow(db, electionId);
  // The RO rules on challenges. After declaration the RO term has
  // ended; the narrow challenge-only authority (spec 12.2 DEFAULT)
  // lets the same uid rule until the window closes, and nothing else.
  if (callerUid !== election.returningOfficerUid) {
    throw new ElectionError(
      "not_returning_officer",
      403,
      "Only the Returning Officer for this election may rule on its challenges.",
    );
  }
  const found = await getCntDoc(db, electionId, "challenges", challengeId);
  if (!found) {
    throw new ElectionError("challenge_not_found", 404, "Challenge not found.");
  }
  await updateCntDoc(db, electionId, "challenges", challengeId, {
    status: input.upheld ? "upheld" : "dismissed",
    roRuling: {
      ruledByUid: callerUid,
      ruledAt: tsFromMillis(nowMillis),
      ruling: input.ruling,
      effectOnResult: input.effectOnResult,
    },
  });

  // An effect beyond "none" never edits result/main: it creates a
  // superseding result record (spec 6.7 step 2).
  if (input.effectOnResult !== "none") {
    await addCntDoc(db, electionId, "result_amendments", {
        kind: "superseding_result_record",
        challengeId,
        effectOnResult: input.effectOnResult,
        ruling: input.ruling,
        recordedByUid: callerUid,
        recordedAt: tsFromMillis(nowMillis),
      });
  }
  await writeElectionAudit(db, {
    action: "election.challenge_ruling",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { challengeId, effectOnResult: input.effectOnResult, upheld: input.upheld },
  });
}
