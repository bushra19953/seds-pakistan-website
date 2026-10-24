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

function rollCollection(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId).collection("voter_roll");
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
  const coll = rollCollection(db, electionId);

  // Rebuild from scratch: clear any pre-freeze build first.
  const existing = await coll.get();
  for (const d of existing.docs) {
    await d.ref.delete();
  }
  for (const m of members) {
    await coll.doc(m.uid).set({
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

  const coll = rollCollection(db, electionId);
  const snap = await coll.get();
  const entries: Array<Parameters<typeof rollEntryCanonical>[0]> = [];
  for (const d of snap.docs) {
    const data = d.data();
    await d.ref.update({ frozenAt: tsFromMillis(nowMillis) });
    entries.push({
      uid: data.uid,
      displayName: data.displayName,
      chapterId: data.chapterId ?? null,
      fullMemberSinceMillis:
        data.fullMemberSince != null ? millisOf(data.fullMemberSince) : null,
      duesYear: data.duesYear ?? "",
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
  const snap = await rollCollection(db, electionId).doc(uid).get();
  if (!snap.exists) return null;
  return snap.data() as VoterRollEntry;
}

export async function listRollEntries(
  db: Db,
  electionId: string,
): Promise<VoterRollEntry[]> {
  const snap = await rollCollection(db, electionId).get();
  return snap.docs.map(
    (d: { data: () => unknown }) => d.data() as VoterRollEntry,
  );
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
