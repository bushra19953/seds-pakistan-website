/**
 * Voter roll build and freeze (spec Sections 3.3, 4 route 5, 6.2).
 *
 * The roll is a stored snapshot of the Phase 1 derived Full Member set
 * at a stated freeze moment. After freeze it is immutable: the API
 * refuses roll writes, a member who becomes a Full Member after the
 * freeze is not added, and a member who loses Full Member status after
 * the freeze is not removed. Disputes are decided against this
 * snapshot. The cast path checks the roll doc, never the users
 * collection.
 */

import type { VoterRollEntry } from "@/types/elections";
import { ElectionError, sha256Hex, type ElectionPorts } from "./election-ports";
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
  supaDeleteSubDoc,
  supaGetSubDoc,
  supaListSubDocs,
  supaSetSubDoc,
  supaUpdateSubDoc,
} from "./election-domain-supa";
import { rethrowIfElectionsPrimary } from "./supa-primary";

function rollCollection(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("voter_roll");
}

// ---------------------------------------------------------------------------
// Data-access helpers: the ONLY branch point between Firestore and
// Supabase for the voter_roll subcollection (elections/{id}/voter_roll
// -> fs_group_voter_roll). Eligibility is NOT decided here and is not
// changed by the migration: buildRoll still takes the member set from
// ports.fullMembers (the Phase 1 port, G1's seam) exactly as before,
// and the stored snapshot shape is byte-identical. Timestamp fields
// (fullMemberSince, registerEntryDate, frozenAt) are converted by the
// seam: Timestamp -> ISO string on write, ISO string -> Timestamp-
// shaped object on read, so millisOf() sees the same millis.
// Flag OFF / unconfigured / any Supabase error -> Firestore helper.
// ---------------------------------------------------------------------------

interface RollDoc {
  id: string;
  data: Record<string, unknown>;
}

async function listRollDocs(db: Db, electionId: string): Promise<RollDoc[]> {
  if (electionsSupaEnabled()) {
    try {
      return await supaListSubDocs(electionId, "voter_roll");
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await rollCollection(db, electionId).get();
  return snap.docs.map(
    (d: { id: string; data: () => Record<string, unknown> }) => ({
      id: d.id,
      data: d.data(),
    }),
  );
}

async function getRollDoc(
  db: Db,
  electionId: string,
  uid: string,
): Promise<RollDoc | null> {
  if (electionsSupaEnabled()) {
    try {
      return await supaGetSubDoc(electionId, "voter_roll", uid);
    } catch {
      // Fall through to Firestore (fallback contract).
    }
  }
  const snap = await rollCollection(db, electionId).doc(uid).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() as Record<string, unknown> };
}

async function setRollDoc(
  db: Db,
  electionId: string,
  uid: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaSetSubDoc(electionId, "voter_roll", uid, data);
      return;
    } catch (err) {
      rethrowIfElectionsPrimary(err);
      // Fall through to Firestore (fallback contract).
    }
  }
  await rollCollection(db, electionId).doc(uid).set(data);
}

async function deleteRollDoc(db: Db, electionId: string, uid: string): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaDeleteSubDoc(electionId, "voter_roll", uid);
      return;
    } catch (err) {
      rethrowIfElectionsPrimary(err);
      // Fall through to Firestore (fallback contract).
    }
  }
  await rollCollection(db, electionId).doc(uid).delete();
}

async function stampRollDocFrozenAt(
  db: Db,
  electionId: string,
  uid: string,
  nowMillis: number,
): Promise<void> {
  if (electionsSupaEnabled()) {
    try {
      await supaUpdateSubDoc(electionId, "voter_roll", uid, {
        frozenAt: tsFromMillis(nowMillis),
      });
      return;
    } catch (err) {
      rethrowIfElectionsPrimary(err);
      // Fall through to Firestore (fallback contract).
    }
  }
  await rollCollection(db, electionId)
    .doc(uid)
    .update({ frozenAt: tsFromMillis(nowMillis) });
}

/** Canonical string per entry for the roll hash (dispute evidence). */
export function rollEntryCanonical(e: {
  uid: string;
  displayName: string;
  chapterId: string | null;
  fullMemberSinceMillis: number | null;
  duesYear: string;
  eligibleToVote: boolean;
}): string {
  return [
    e.uid,
    e.displayName,
    e.chapterId ?? "",
    e.fullMemberSinceMillis === null ? "" : String(e.fullMemberSinceMillis),
    e.duesYear,
    e.eligibleToVote ? "1" : "0",
  ].join("|");
}

export function computeRollHash(
  entries: Array<Parameters<typeof rollEntryCanonical>[0]>,
): string {
  const sorted = [...entries]
    .map(rollEntryCanonical)
    .sort()
    .join("\n");
  return sha256Hex(sorted);
}

export async function buildRoll(
  db: Db,
  ports: ElectionPorts,
  electionId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<{ rollSize: number }> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  if (election.voterRoll.status === "frozen") {
    throw new ElectionError(
      "roll_frozen",
      409,
      "The voter roll is frozen and cannot be rebuilt.",
    );
  }

  const members = await ports.fullMembers.listFullMembers();

  // Rebuild from scratch: clear any pre-freeze build first.
  const existing = await listRollDocs(db, electionId);
  for (const d of existing) {
    await deleteRollDoc(db, electionId, d.id);
  }
  for (const m of members) {
    await setRollDoc(db, electionId, m.uid, {
      uid: m.uid,
      displayName: m.displayName,
      chapterId: m.chapterId,
      fullMemberSince:
        m.fullMemberSinceMillis !== null
          ? tsFromMillis(m.fullMemberSinceMillis)
          : null,
      duesYear: m.duesYear,
      registerEntryDate:
        m.registerEntryDateMillis !== null
          ? tsFromMillis(m.registerEntryDateMillis)
          : null,
      eligibleToVote: true,
      exclusionReason: null,
      frozenAt: null,
    });
  }

  await electionRef(db, electionId).update({
    voterRoll: {
      ...election.voterRoll,
      status: "built",
      builtAt: tsFromMillis(nowMillis),
      rollSize: members.length,
    },
    updatedAt: serverTimestamp(),
  });
  await writeElectionAudit(db, {
    action: "election.roll_build",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { rollSize: members.length, at: nowMillis },
  });
  return { rollSize: members.length };
}

export async function freezeRoll(
  db: Db,
  electionId: string,
  callerUid: string,
  nowMillis: number = Date.now(),
): Promise<{ rollSize: number; rollHash: string; frozenAt: number }> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  if (election.voterRoll.status === "frozen") {
    throw new ElectionError("roll_frozen", 409, "The voter roll is already frozen.");
  }
  if (election.voterRoll.status !== "built") {
    throw new ElectionError(
      "roll_not_built",
      409,
      "Build the voter roll before freezing it.",
    );
  }

  const docs = await listRollDocs(db, electionId);
  const entries: Array<Parameters<typeof rollEntryCanonical>[0]> = [];
  for (const d of docs) {
    const data = d.data;
    await stampRollDocFrozenAt(db, electionId, d.id, nowMillis);
    entries.push({
      uid: data.uid as string,
      displayName: data.displayName as string,
      chapterId: (data.chapterId ?? null) as string | null,
      fullMemberSinceMillis:
        data.fullMemberSince != null ? millisOf(data.fullMemberSince) : null,
      duesYear: (data.duesYear ?? "") as string,
      eligibleToVote: data.eligibleToVote !== false,
    });
  }
  const rollHash = computeRollHash(entries);

  await electionRef(db, electionId).update({
    voterRoll: {
      status: "frozen",
      builtAt: election.voterRoll.builtAt,
      frozenAt: tsFromMillis(nowMillis),
      rollSize: entries.length,
      rollHash,
    },
    updatedAt: serverTimestamp(),
  });
  await writeElectionAudit(db, {
    action: "election.roll_freeze",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { rollSize: entries.length, rollHash, frozenAt: nowMillis },
  });
  return { rollSize: entries.length, rollHash, frozenAt: nowMillis };
}

/** Post-freeze write attempts land here and are refused (spec test 12). */
export async function assertRollWritable(
  db: Db,
  electionId: string,
): Promise<void> {
  const election = await getElectionOrThrow(db, electionId);
  if (election.voterRoll.status === "frozen") {
    throw new ElectionError(
      "roll_frozen",
      409,
      "The voter roll is frozen; no roll writes are accepted.",
    );
  }
}

export async function getRollEntry(
  db: Db,
  electionId: string,
  uid: string,
): Promise<VoterRollEntry | null> {
  const doc = await getRollDoc(db, electionId, uid);
  if (!doc) return null;
  return doc.data as unknown as VoterRollEntry;
}

export async function listRollEntries(
  db: Db,
  electionId: string,
): Promise<VoterRollEntry[]> {
  const docs = await listRollDocs(db, electionId);
  return docs.map((d) => d.data as unknown as VoterRollEntry);
}

export async function isOnFrozenRoll(
  db: Db,
  electionId: string,
  uid: string,
): Promise<boolean> {
  const election = await getElectionOrThrow(db, electionId);
  if (election.voterRoll.status !== "frozen") return false;
  const entry = await getRollEntry(db, electionId, uid);
  return entry !== null && entry.eligibleToVote !== false;
}
