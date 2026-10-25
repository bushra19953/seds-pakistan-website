/**
 * Shared internals for the elections server modules: timestamp
 * conversion, doc access, and the per-election RO gate.
 */

import admin from "firebase-admin";
import type { Election, FsTimestamp } from "@/types/elections";
import { ElectionError, toMillis } from "./election-ports";
import { trySupa, fromSupaDoc, toSupaDoc } from "./election-supa";

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
  // Supa path (flag ON + adapter configured): fs_elections row, with
  // ISO-string timestamps converted back to FsTimestamp shape by the
  // seam. Adapter error / flag OFF / unconfigured falls through to the
  // exact Firestore read below.
  const supa = await trySupa((a) => a.getDoc("elections", electionId));
  if (supa.ok) {
    if (!supa.value) {
      throw new ElectionError("election_not_found", 404, "Election not found.");
    }
    return electionFromDoc(electionId, fromSupaDoc(supa.value));
  }
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
 * Seam-aware election doc write (set). On the Supa path the payload is
 * converted with toSupaDoc (Timestamps -> ISO strings; the
 * serverTimestamp sentinel -> nowMillis as ISO). On any fallback the
 * original payload goes to the given Firestore ref untouched.
 */
export async function setElectionDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: any,
  data: Record<string, unknown>,
  nowMillis?: number,
): Promise<void> {
  const supa = await trySupa((a) =>
    a.setDoc("elections", ref.id as string, toSupaDoc(data, nowMillis)),
  );
  if (supa.ok) return;
  await ref.set(data);
}

/** Seam-aware election doc update; see setElectionDoc. */
export async function updateElectionDoc(
  db: Db,
  electionId: string,
  patch: Record<string, unknown>,
  nowMillis?: number,
): Promise<void> {
  const supa = await trySupa((a) =>
    a.updateDoc("elections", electionId, toSupaDoc(patch, nowMillis)),
  );
  if (supa.ok) return;
  await electionRef(db, electionId).update(patch);
}

/**
 * Seam-aware full elections listing for the lifecycle sweeps. Returns
 * null on fallback, in which case the caller runs its original
 * Firestore scan (per-doc getElectionOrThrow) unchanged.
 */
export async function listElectionsViaSupa(): Promise<Election[] | null> {
  const supa = await trySupa((a) => a.listDocs("elections"));
  if (!supa.ok) return null;
  return supa.value.map((doc) =>
    electionFromDoc(String(doc.id), fromSupaDoc(doc)),
  );
}

/**
 * Seam-aware pending-nominations count for the vetting-overdue sweep.
 * Returns null on fallback; the caller then runs its original
 * Firestore count() aggregation unchanged.
 */
export async function countPendingNominationsViaSupa(
  electionId: string,
): Promise<number | null> {
  const supa = await trySupa((a) =>
    a.countDocs(`elections/${electionId}/nominations`, [
      ["status", "in", ["submitted", "under_review"]],
    ]),
  );
  if (!supa.ok) return null;
  return supa.value;
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
