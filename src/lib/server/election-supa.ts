/**
 * election-supa.ts — THE Supabase seam for the elections core group
 * (election-db.ts, election-ports.ts, elections.ts,
 * election-route-helpers.ts).
 *
 * Every Supabase access from those modules flows through this one file,
 * so re-pointing at the real adapter at merge time is a one-import
 * change: the adapter lives in src/lib/supa/ (sibling branch
 * feat/supa-adapter, NOT in this tree) and exposes:
 *
 *   getDoc(collection, id)
 *   listDocs(collection, { where, orderBy, limit, startAfter })
 *   countDocs(collection, where)
 *   setDoc(collection, id, data, { merge? })
 *   updateDoc(collection, id, data)
 *   deleteDoc(collection, id)
 *   useSupa(surface)  — SUPA_SURFACES env flag, default OFF
 *   getSupaClient()   — null when SUPABASE_URL / service key unset
 *
 * over fs_<collection> jsonb tables (id text pk, firebase_uid,
 * parent_path, data jsonb, migrated_at). Subcollections are addressed
 * by 3-segment paths ("elections/{id}/nominations").
 *
 * Resolution order for the adapter:
 *   1. an adapter registered with registerElectionSupaAdapter()
 *      (unit tests, and the merge-time wiring if it prefers explicit
 *      registration);
 *   2. a dynamic import of "@/lib/supa" (the real adapter branch);
 *      a missing module, a null client, or any load error resolves to
 *      null, i.e. "unconfigured".
 *
 * Fallback contract (applies to every caller of this seam):
 *   flag OFF, adapter unconfigured, or adapter error
 *     => the caller runs its EXACT current Firestore path, with
 *        byte-identical response shapes.
 * Fallback is per-operation: trySupa() reports { ok: false } and the
 * caller falls through to Firestore for that one operation.
 *
 * Timestamp conversions (jsonb stores Firestore Timestamps as ISO
 * strings; the elections types carry FsTimestamp objects):
 *   WRITE (toSupaData): any Timestamp-like value (object exposing
 *     toMillis() + seconds), any Date, and any serverTimestamp
 *     sentinel are converted — recursively — to ISO strings.
 *     serverTimestamp sentinels become the caller-supplied nowMillis
 *     (or Date.now()), because jsonb has no server-time sentinel;
 *     callers that know their logical now pass it explicitly.
 *   READ (fromSupaData): values under the KNOWN timestamp field names
 *     in TIMESTAMP_FIELDS that arrive as ISO strings (or numbers) are
 *     converted back to FsTimestamp-shaped objects
 *     ({ seconds, nanoseconds, toMillis(), toDate() }), so helpers
 *     like toMillis()/millisOf() and timetable code behave exactly as
 *     they do on Firestore data. All other strings are untouched —
 *     in particular voter-roll snapshot content and free-text fields
 *     are returned byte-identical.
 */

import { randomUUID } from "crypto";
import type { FsTimestamp } from "@/types/elections";

/* ------------------------------------------------------------------ types */

export type SupaWhereClause = [field: string, op: string, value: unknown];

export interface SupaListOptions {
  where?: SupaWhereClause[];
  orderBy?: string | { field: string; direction?: "asc" | "desc" } | Array<{ field: string; direction?: "asc" | "desc" }>;
  limit?: number;
  startAfter?: string | number;
}

/** Structural shape of the src/lib/supa adapter (merge-time import). */
export interface ElectionSupaAdapter {
  getDoc(collection: string, id: string): Promise<Record<string, unknown> | null>;
  listDocs(collection: string, options?: SupaListOptions): Promise<Array<Record<string, unknown>>>;
  countDocs(collection: string, where?: SupaWhereClause[]): Promise<number>;
  setDoc(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
  updateDoc(collection: string, id: string, data: Record<string, unknown>): Promise<unknown>;
  deleteDoc(collection: string, id: string): Promise<void>;
}

/** Surface name this cluster gates on: SUPA_SURFACES=elections. */
export const ELECTIONS_SUPA_SURFACE = "elections";

/* ------------------------------------------------------------- flag check */

/**
 * Local copy of the adapter's useSupa() semantics (SUPA_SURFACES,
 * comma-separated, case-insensitive, "*" = all on, unset = all off).
 * Kept local so the flag check never depends on the adapter module
 * being present in this tree; identical semantics to
 * src/lib/supa/flags.ts on the adapter branch.
 */
export function useSupaElections(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes("*")) return true;
  return surfaces.includes(ELECTIONS_SUPA_SURFACE);
}

/* ------------------------------------------------------ adapter registry */

let registeredAdapter: ElectionSupaAdapter | null | undefined = undefined;

/**
 * Register the adapter explicitly. Tests inject a fake here; passing
 * null pins "unconfigured" (the dynamic import is then skipped, which
 * is also what tests want). resetElectionSupaAdapter() restores the
 * default dynamic-import resolution.
 */
export function registerElectionSupaAdapter(
  adapter: ElectionSupaAdapter | null,
): void {
  registeredAdapter = adapter;
}

export function resetElectionSupaAdapter(): void {
  registeredAdapter = undefined;
}

export async function resolveElectionSupaAdapter(): Promise<ElectionSupaAdapter | null> {
  if (registeredAdapter !== undefined) return registeredAdapter;
  try {
    // The adapter module is built on a sibling branch and merged in
    // later; the ts-ignore keeps this tree compiling standalone, and
    // any resolution failure simply means "unconfigured" -> fallback.
    // @ts-ignore - "@/lib/supa" does not exist in this worktree yet.
    const mod = await import("@/lib/supa");
    const m = mod as {
      getSupaClient?: () => unknown;
      getSupaAdapter?: () => ElectionSupaAdapter;
    };
    if (typeof m.getSupaAdapter !== "function") return null;
    if (typeof m.getSupaClient === "function" && !m.getSupaClient()) {
      return null;
    }
    return m.getSupaAdapter();
  } catch {
    return null;
  }
}

/** True only when the flag is ON and an adapter is actually available. */
export async function electionSupaActive(): Promise<boolean> {
  if (!useSupaElections()) return false;
  return (await resolveElectionSupaAdapter()) !== null;
}

/* ------------------------------------------------------------ try wrapper */

export type SupaAttempt<T> = { ok: true; value: T } | { ok: false };

/**
 * Run one adapter operation under the fallback contract. Returns
 * { ok: false } when the flag is off, the adapter is unconfigured, or
 * the operation throws — the caller then runs its Firestore path.
 */
export async function trySupa<T>(
  fn: (adapter: ElectionSupaAdapter) => Promise<T>,
): Promise<SupaAttempt<T>> {
  if (!useSupaElections()) return { ok: false };
  const adapter = await resolveElectionSupaAdapter();
  if (!adapter) return { ok: false };
  try {
    return { ok: true, value: await fn(adapter) };
  } catch {
    return { ok: false };
  }
}

/* --------------------------------------------------- timestamp conversion */

/**
 * Field names whose values are FsTimestamps in the elections data
 * model (src/types/elections.ts). Read conversion applies ONLY to
 * these keys, so free-text/date-string fields are never reinterpreted.
 */
const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([
  // Election doc + timetable + voter-roll meta
  "appointedAt",
  "roTermEndsAt",
  "createdAt",
  "updatedAt",
  "electionDay",
  "timetablePublishedAt",
  "nominationOpenAt",
  "nominationCloseAt",
  "vettingDeadlineAt",
  "candidateListDate",
  "candidateListPublishedAt",
  "pollOpenAt",
  "pollCloseAt",
  "challengeWindowClosesAt",
  "certificateDeadlineAt",
  "builtAt",
  "frozenAt",
  // users / roles records read through the ports
  "fullMemberSince",
  "registerEntryDate",
  // generic stored-doc timestamps elsewhere in the port collections
  "issuedAt",
  "expiresAt",
  "redeemedAt",
  "uploadedAt",
  "checkedAt",
  "decidedAt",
  "certifiedAt",
  "submittedAt",
  "openedAt",
  "signedOffAt",
  "drawnAt",
  "recordedAt",
  "declaredAt",
  "publishedAt",
  "filedAt",
  "ruledAt",
  "scheduledAt",
  "verifiedAt",
  "termStart",
  "termEnd",
]);

/** Build an FsTimestamp-shaped object (same shape the fake + admin
 *  Timestamps present to toMillis()/toDate() consumers). */
export function tsLikeFromMillis(millis: number): FsTimestamp {
  const seconds = Math.floor(millis / 1000);
  const nanoseconds = Math.floor((millis - seconds * 1000) * 1e6);
  return {
    seconds,
    nanoseconds,
    toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1e6),
    toDate: () => new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6)),
  };
}

function isTimestampLike(value: unknown): value is { toMillis: () => number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.toMillis === "function" && typeof v.seconds === "number";
}

function isServerTimestampSentinel(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // Fake-firestore sentinel used by the unit-test fake.
  if (v.__fakeFieldValue === "serverTimestamp") return true;
  // Admin SDK FieldValue.serverTimestamp() sentinel.
  if (v._methodName === "FieldValue.serverTimestamp") return true;
  return false;
}

/**
 * WRITE conversion: deep-convert a Firestore-shaped payload into the
 * jsonb shape — Timestamp-like values and Dates become ISO strings;
 * serverTimestamp sentinels become `nowMillis` (caller's logical now)
 * as an ISO string. Everything else is copied structurally.
 */
export function toSupaData(value: unknown, nowMillis: number = Date.now()): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (isServerTimestampSentinel(value)) {
    return new Date(nowMillis).toISOString();
  }
  if (isTimestampLike(value)) {
    return new Date(value.toMillis()).toISOString();
  }
  if (Array.isArray(value)) return value.map((v) => toSupaData(v, nowMillis));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toSupaData(v, nowMillis);
    }
    return out;
  }
  return value;
}

export function toSupaDoc(
  data: Record<string, unknown>,
  nowMillis?: number,
): Record<string, unknown> {
  return toSupaData(data, nowMillis) as Record<string, unknown>;
}

const ISO_STRING_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * READ conversion: deep-copy adapter data back into the Firestore
 * shape. Only values under TIMESTAMP_FIELDS keys are converted: ISO
 * strings and epoch numbers become FsTimestamp-shaped objects. All
 * other values — including date-like strings under other keys — pass
 * through byte-identical, which is what keeps frozen voter-roll
 * snapshots identical.
 */
export function fromSupaData(value: unknown, key?: string): unknown {
  if (key !== undefined && TIMESTAMP_FIELDS.has(key)) {
    if (typeof value === "string" && ISO_STRING_RE.test(value)) {
      const millis = Date.parse(value);
      if (!Number.isNaN(millis)) return tsLikeFromMillis(millis);
    }
    if (typeof value === "number") return tsLikeFromMillis(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => fromSupaData(v));
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    if (isTimestampLike(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = fromSupaData(v, k);
    }
    return out;
  }
  return value;
}

export function fromSupaDoc(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  return fromSupaData(doc) as Record<string, unknown>;
}

/* ------------------------------------------------------------- id minting */

/**
 * Mint a document id for an adapter write that Firestore would have
 * addressed through collection().doc(). Prefers the Firestore client's
 * own auto-id (no I/O — doc() with no argument only generates an id
 * locally) so id shape stays identical while a db handle exists; falls
 * back to a UUID when no usable db handle is present.
 */
export function mintSupaId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  collection: string,
): string {
  try {
    if (db && typeof db.collection === "function") {
      const ref = db.collection(collection).doc();
      if (ref && typeof ref.id === "string" && ref.id) return ref.id as string;
    }
  } catch {
    // fall through to UUID
  }
  return randomUUID();
}
