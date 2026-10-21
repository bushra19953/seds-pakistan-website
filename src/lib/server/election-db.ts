/**
 * Shared internals for the elections server modules: timestamp
 * conversion, doc access, and the per-election RO gate.
 */

import admin from "firebase-admin";
import type { Election, FsTimestamp } from "@/types/elections";
import { ElectionError, toMillis } from "./election-ports";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export function tsFromMillis(millis: number): FsTimestamp {
  return admin.firestore.Timestamp.fromMillis(millis) as unknown as FsTimestamp;
}

export function serverTimestamp(): unknown {
  return admin.firestore.FieldValue.serverTimestamp();
}

export function millisOf(value: unknown): number {
  return toMillis(value);
}

/** Convert a stored election doc (Firestore shape) to typed Election. */
export function electionFromDoc(
  id: string,
  data: Record<string, unknown>,
): Election {
  return { id, ...(data as unknown as Omit<Election, "id">) };
}

export async function getElectionOrThrow(
  db: Db,
  electionId: string,
): Promise<Election> {
  const snap = await db.collection("elections").doc(electionId).get();
  if (!snap.exists) {
    throw new ElectionError("election_not_found", 404, "Election not found.");
  }
  return electionFromDoc(snap.id, snap.data());
}

export function electionRef(db: Db, electionId: string) {
  return db.collection("elections").doc(electionId);
}

/**
 * The per-election RO gate: caller uid must equal the election's
 * returningOfficerUid. Holding the returning_officer role alone is NOT
 * sufficient (spec Section 4 preamble); routes additionally check the
 * role through Phase 1's resolveCanonicalRole.
 */
export function assertRo(election: Election, callerUid: string): void {
  if (election.returningOfficerUid !== callerUid) {
    throw new ElectionError(
      "not_returning_officer",
      403,
      "Caller is not the Returning Officer for this election.",
    );
  }
}

export function assertElectionStatus(
  election: Election,
  allowed: string[],
  action: string,
): void {
  if (!allowed.includes(election.status)) {
    throw new ElectionError(
      "invalid_status",
      409,
      `Cannot ${action} while the election is in status "${election.status}".`,
    );
  }
}
