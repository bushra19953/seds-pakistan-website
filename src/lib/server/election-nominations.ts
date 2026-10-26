/**
 * Nominations: submit, eligibility evaluation, RO vetting, certified
 * list (spec Sections 3.5, 4 routes 7-9, 6.2).
 *
 * Rules:
 * - Exactly 2 nominators, distinct, neither the candidate, all on the
 *   frozen roll (Procedure Manual Sec 7.3; the "exactly 2" reading is
 *   the spec's qualifying rule, ambiguity flagged in spec 12.3 item 1).
 * - The candidate cannot be the Returning Officer. Enforced at submit,
 *   at validation, at certification, and again at count open (the RO
 *   conflict rule). If the RO submits or accepts a nomination naming
 *   themselves the action is rejected and audit-logged.
 * - Candidate written consent (Drive, kind governance) must be recorded
 *   before submission; the campaign code must be accepted.
 * - Eligibility facts (Full Member, 6 consecutive months standing at
 *   nomination close, active Strikes) are EVALUATED AND STORED at
 *   submit; failing them does not block submission - Sec 7.4 makes
 *   verification the RO's act, so the route records facts, the RO
 *   decides. Strikes come through the Phase 2 discipline port; when
 *   the port cannot answer, the check is marked "ro_attestation"
 *   (manual), never silently passed.
 */

import type { Nomination } from "@/types/elections";
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
import { getRollEntry, listRollEntries } from "./election-roll";
import {
  electionsSupaEnabled,
  supaAddSubDoc,
  supaGetSubDoc,
  supaListSubDocs,
  supaUpdateSubDoc,
} from "./election-domain-supa";
import { rethrowIfElectionsPrimary } from "./supa-primary";

function nominationsCollection(db: Db, electionId: string) {
  return db
    .collection("elections")
    .doc(electionId)
    .collection("nominations");
}

// ---------------------------------------------------------------------------
// Data-access helpers: the ONLY branch point between Firestore and
// Supabase for the nominations subcollection (elections/{id}/nominations
// -> fs_group_nominations). Stored shape is byte-identical; timestamp
// fields (submittedAt, updatedAt, certifiedAt, campaignCodeAcceptedAt,
// consent.uploadedAt, eligibility.fullMemberSince, eligibility.checkedAt,
// roDecision.decidedAt) are converted by the seam (Timestamp -> ISO on
// write, ISO -> Timestamp-shaped object on read). Flag OFF /
// unconfigured / any Supabase error -> Firestore helper.
// ---------------------------------------------------------------------------

interface NomDoc {
  id: string;
  data: Record<string, unknown>;
}

async function listNomDocs(db: Db, electionId: string): Promise<NomDoc[]> {
  if (electionsSupaEnabled()) {
    try {
      return await supaListSubDocs(electionId, "nominations");
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await nominationsCollection(db, electionId).get();
  return snap.docs.map(
    (d: { id: string; data: () => Record<string, unknown> }) => ({
      id: d.id,
      data: d.data(),
    }),
  );
}

async function listNomDocsByCandidate(
  db: Db,
  electionId: string,
  candidateUid: string,
): Promise<NomDoc[]> {
  if (electionsSupaEnabled()) {
    try {
      return await supaListSubDocs(electionId, "nominations", [
        ["candidateUid", "==", candidateUid],
      ]);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await nominationsCollection(db, electionId)
    .where("candidateUid", "==", candidateUid)
    .get();
  return snap.docs.map(
    (d: { id: string; data: () => Record<string, unknown> }) => ({
      id: d.id,
      data: d.data(),
    }),
  );
}

async function getNomDoc(
  db: Db,
  electionId: string,
  nominationId: string,
): Promise<NomDoc | null> {
  if (electionsSupaEnabled()) {
    try {
      return await supaGetSubDoc(electionId, "nominations", nominationId);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await nominationsCollection(db, electionId).doc(nominationId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() as Record<string, unknown> };
}

async function addNomDoc(
  db: Db,
  electionId: string,
  data: Record<string, unknown>,
): Promise<string> {
  if (electionsSupaEnabled()) {
    try {
      return await supaAddSubDoc(electionId, "nominations", data);
    } catch (err) {
      rethrowIfElectionsPrimary(err);
      // Fall through to Firestore (fallback contract).
    }
  }
  const ref = nominationsCollection(db, electionId).doc();
  await ref.set(data);
  return ref.id as string;
}

async function updateNomDoc(
  db: Db,
  electionId: string,
  nominationId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaUpdateSubDoc(electionId, "nominations", nominationId, updates);
      return;
    } catch (err) {
      rethrowIfElectionsPrimary(err);
      // Fall through to Firestore (fallback contract).
    }
  }
  await nominationsCollection(db, electionId).doc(nominationId).update(updates);
}

/** Add 6 calendar months (UTC) - the Sec 7.3 standing measure. */
export function addSixMonths(millis: number): number {
  const d = new Date(millis);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + 6,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

export interface SubmitNominationInput {
  submitterUid: string;
  candidateUid: string;
  candidateName: string;
  nominatorUids: string[];
  candidateStatement: string;
  consent: {
    driveFileId: string;
    driveLink: string;
    fileName: string;
    sha256: string;
    uploadedByUid: string;
  };
  campaignCodeAccepted: boolean;
}

export async function submitNomination(
  db: Db,
  ports: ElectionPorts,
  electionId: string,
  input: SubmitNominationInput,
  nowMillis: number = Date.now(),
): Promise<Nomination> {
  const election = await getElectionOrThrow(db, electionId);

  if (election.status !== "nominations_open") {
    throw new ElectionError(
      "nominations_not_open",
      409,
      "Nominations are not open for this election.",
    );
  }
  const openAt = millisOf(election.timetable.nominationOpenAt);
  const closeAt = millisOf(election.timetable.nominationCloseAt);
  if (nowMillis < openAt || nowMillis > closeAt) {
    throw new ElectionError(
      "outside_nomination_window",
      409,
      "The nomination window is not open at this time.",
    );
  }
  if (election.voterRoll.status !== "frozen") {
    throw new ElectionError(
      "roll_not_frozen",
      409,
      "The voter roll must be frozen before nominations are accepted.",
    );
  }

  // Nominator shape: exactly 2, distinct, neither the candidate.
  const nominators = input.nominatorUids ?? [];
  if (nominators.length !== 2) {
    throw new ElectionError(
      "nominator_count",
      422,
      "A nomination requires exactly 2 nominators.",
    );
  }
  if (new Set(nominators).size !== nominators.length) {
    throw new ElectionError(
      "nominator_duplicate",
      422,
      "The two nominators must be distinct members.",
    );
  }
  if (nominators.includes(input.candidateUid)) {
    throw new ElectionError(
      "nominator_is_candidate",
      422,
      "A candidate cannot nominate themselves.",
    );
  }

  // RO conflict: the RO can never be a candidate in their own election.
  if (input.candidateUid === election.returningOfficerUid) {
    await writeElectionAudit(db, {
      action: "election.nomination_rejected_ro_candidate",
      actorUid: input.submitterUid,
      targetUidOrResource: `election:${electionId}`,
      payload: { candidateUid: input.candidateUid, stage: "submit" },
    });
    throw new ElectionError(
      "ro_is_candidate",
      422,
      "The Returning Officer cannot be a candidate in an election they run.",
    );
  }

  if (!input.campaignCodeAccepted) {
    throw new ElectionError(
      "campaign_code_not_accepted",
      422,
      "The candidate must accept the campaign code of conduct (Sec 7.5).",
    );
  }
  if (!input.consent || !input.consent.driveFileId || !input.consent.sha256) {
    throw new ElectionError(
      "consent_missing",
      422,
      "The candidate's written consent (Drive, kind governance) must be recorded before submission.",
    );
  }
  if ((input.candidateStatement ?? "").length > 2000) {
    throw new ElectionError(
      "statement_too_long",
      422,
      "Candidate statement exceeds 2000 characters.",
    );
  }

  // Roll membership: candidate and both nominators on the frozen roll.
  const candidateEntry = await getRollEntry(db, electionId, input.candidateUid);
  if (!candidateEntry || candidateEntry.eligibleToVote === false) {
    throw new ElectionError(
      "candidate_not_on_roll",
      422,
      "The candidate is not on the frozen voter roll.",
    );
  }
  for (const n of nominators) {
    const entry = await getRollEntry(db, electionId, n);
    if (!entry || entry.eligibleToVote === false) {
      throw new ElectionError(
        "nominator_not_on_roll",
        422,
        `Nominator ${n} is not on the frozen voter roll.`,
      );
    }
  }

  // One live nomination per candidate per election.
  const existing = await listNomDocsByCandidate(db, electionId, input.candidateUid);
  for (const d of existing) {
    const st = d.data.status;
    if (st === "submitted" || st === "under_review" || st === "accepted") {
      throw new ElectionError(
        "candidate_already_nominated",
        409,
        "This candidate already has a live nomination in this election.",
      );
    }
  }

  // Eligibility facts recorded at submit (the RO decides, Sec 7.4).
  const fullMemberSince =
    candidateEntry.fullMemberSince != null
      ? millisOf(candidateEntry.fullMemberSince)
      : null;
  const sixMonthStandingMet =
    fullMemberSince !== null && addSixMonths(fullMemberSince) <= closeAt;
  let strikes: { activeStrikes: number | null; source: "port" | "ro_attestation" };
  try {
    strikes = await ports.discipline.activeStrikes(input.candidateUid);
  } catch {
    strikes = { activeStrikes: null, source: "ro_attestation" };
  }

  const doc: Record<string, unknown> = {
    electionId,
    candidateUid: input.candidateUid,
    candidateName: input.candidateName,
    nominatorUids: nominators,
    candidateStatement: input.candidateStatement ?? "",
    consent: {
      ...input.consent,
      uploadedAt: tsFromMillis(nowMillis),
    },
    campaignCodeAcceptedAt: tsFromMillis(nowMillis),
    eligibility: {
      isFullMember: true,
      fullMemberSince:
        fullMemberSince !== null ? tsFromMillis(fullMemberSince) : null,
      sixMonthStandingMet,
      activeStrikes: strikes.activeStrikes,
      strikesCheckSource: strikes.source,
      checkedAt: tsFromMillis(nowMillis),
    },
    status: "submitted",
    roDecision: null,
    certifiedAt: null,
    submittedAt: tsFromMillis(nowMillis),
    updatedAt: serverTimestamp(),
  };
  const nominationId = await addNomDoc(db, electionId, doc);
  await writeElectionAudit(db, {
    action: "election.nomination_submit",
    actorUid: input.submitterUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { nominationId, candidateUid: input.candidateUid },
  });

  const created = await getNomDoc(db, electionId, nominationId);
  return { id: nominationId, ...(created?.data ?? doc) } as Nomination;
}

export async function decideNomination(
  db: Db,
  electionId: string,
  nominationId: string,
  callerUid: string,
  decision: "accepted" | "rejected",
  reason: string | null,
  nowMillis: number = Date.now(),
): Promise<Nomination> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);

  const found = await getNomDoc(db, electionId, nominationId);
  if (!found) {
    throw new ElectionError("nomination_not_found", 404, "Nomination not found.");
  }
  const nomination = { id: nominationId, ...found.data } as Nomination;

  if (nomination.status !== "submitted" && nomination.status !== "under_review") {
    throw new ElectionError(
      "nomination_already_decided",
      409,
      `Nomination is already "${nomination.status}".`,
    );
  }

  // Defence in depth: the RO can never accept a nomination naming
  // themselves, even if one reached the queue (spec test 15).
  if (nomination.candidateUid === callerUid) {
    await writeElectionAudit(db, {
      action: "election.nomination_rejected_ro_candidate",
      actorUid: callerUid,
      targetUidOrResource: `election:${electionId}`,
      payload: { nominationId, candidateUid: nomination.candidateUid, stage: "decide" },
    });
    throw new ElectionError(
      "ro_is_candidate",
      422,
      "The Returning Officer cannot decide a nomination naming themselves as candidate.",
    );
  }

  if (decision === "rejected" && (!reason || reason.trim().length === 0)) {
    throw new ElectionError(
      "reject_reason_required",
      400,
      "A rejection reason is mandatory and is shown to the candidate and both nominators.",
    );
  }

  await updateNomDoc(db, electionId, nominationId, {
    status: decision,
    roDecision: {
      decidedByUid: callerUid,
      decidedAt: tsFromMillis(nowMillis),
      reason: decision === "rejected" ? reason : (reason ?? null),
    },
    updatedAt: serverTimestamp(),
  });
  await writeElectionAudit(db, {
    action:
      decision === "accepted"
        ? "election.nomination_accept"
        : "election.nomination_reject",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { nominationId, candidateUid: nomination.candidateUid, reason: reason ?? null },
  });

  const after = await getNomDoc(db, electionId, nominationId);
  return { id: nominationId, ...(after?.data ?? {}) } as Nomination;
}

/**
 * Certify the candidate list (route 9). Requires nominations closed,
 * vetting complete (nothing left in submitted / under_review), and at
 * least one accepted nomination. The RO-conflict rule is re-checked
 * here for every accepted nomination.
 */
export async function certifyCandidates(
  db: Db,
  ports: ElectionPorts,
  electionId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<{ certifiedCandidateUids: string[] }> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  if (election.status !== "nominations_closed") {
    throw new ElectionError(
      "nominations_not_closed",
      409,
      "The candidate list can only be certified after nominations close.",
    );
  }

  const nomDocs = await listNomDocs(db, electionId);
  const all: Nomination[] = nomDocs.map(
    (d) => ({ id: d.id, ...d.data }) as unknown as Nomination,
  );
  const unvetted = all.filter(
    (n) => n.status === "submitted" || n.status === "under_review",
  );
  if (unvetted.length > 0) {
    throw new ElectionError(
      "vetting_incomplete",
      409,
      `Certification is blocked: ${unvetted.length} nomination(s) are still unvetted.`,
    );
  }
  const accepted = all.filter((n) => n.status === "accepted");
  if (accepted.length === 0) {
    throw new ElectionError(
      "no_accepted_candidates",
      409,
      "At least one accepted nomination is required to certify a candidate list.",
    );
  }
  for (const n of accepted) {
    if (n.candidateUid === election.returningOfficerUid) {
      throw new ElectionError(
        "ro_is_candidate",
        422,
        "An accepted nomination names the Returning Officer as candidate; certification is blocked.",
      );
    }
  }

  for (const n of accepted) {
    await updateNomDoc(db, electionId, n.id, {
      certifiedAt: tsFromMillis(nowMillis),
    });
  }

  const timetable = {
    ...election.timetable,
    candidateListPublishedAt: tsFromMillis(nowMillis),
  };
  await electionRef(db, electionId).update({
    status: "candidates_certified",
    timetable,
    updatedAt: serverTimestamp(),
  });

  // Publish the certified list to Full Members (notification port).
  // Roll entries come through election-roll's helpers, so this read
  // follows the same Supabase/Firestore branch as the roll itself;
  // entry.uid is the roll doc id (the stored uid field equals it).
  const rollEntries = await listRollEntries(db, electionId);
  for (const entry of rollEntries) {
    await ports.notifications.notifyUser({
      uid: entry.uid,
      type: "election_candidates_certified",
      title: "Certified candidate list published",
      message: `The certified candidate list for "${election.title}" is published.`,
      electionId,
    });
  }

  await writeElectionAudit(db, {
    action: "election.candidates_certified",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: {
      certifiedCandidateUids: accepted.map((n) => n.candidateUid),
      at: nowMillis,
    },
  });

  return { certifiedCandidateUids: accepted.map((n) => n.candidateUid) };
}

export async function listNominations(
  db: Db,
  electionId: string,
): Promise<Nomination[]> {
  const docs = await listNomDocs(db, electionId);
  return docs.map(
    (d) => ({ id: d.id, ...d.data }) as unknown as Nomination,
  );
}

export async function listCertifiedCandidates(
  db: Db,
  electionId: string,
): Promise<Nomination[]> {
  const all = await listNominations(db, electionId);
  return all.filter((n) => n.status === "accepted" && n.certifiedAt !== null);
}
