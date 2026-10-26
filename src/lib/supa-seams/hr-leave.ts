/**
 * Supabase seam for the HR leave surface (leave_requests + leave_audit).
 *
 * This module is the ONLY place in the leave cluster that knows about the
 * Supabase adapter. The adapter interface below is declared locally,
 * byte-identical in shape to the real one in src/lib/supa/adapter.ts
 * (SupaAdapter, SupaDoc, DocData, WhereClause, WhereOp, OrderSpec,
 * ListOptions). getAdapter() delegates to getSupaAdapter() from
 * '@/lib/supa' — re-pointed in cutover W4 (the stub it replaced never
 * resolved a real adapter, so this seam's reads/mirrors no-opped in
 * production; see getSupaClient below).
 *
 * Landing tables (written by the real adapter):
 *   leave_requests -> fs_leave_requests
 *   leave_audit    -> fs_leave_audit
 * Rows: (id text pk, firebase_uid, parent_path, data jsonb, migrated_at);
 * the document body lives in `data`. All filtering in this seam is on
 * `data` jsonb fields (userId, status, ...) via the adapter's WhereClause
 * tuples -- never on the firebase_uid column, which the migration kit
 * leaves unpopulated for the HR tables.
 *
 * Behaviour contract:
 * - Flag OFF (SUPA_SURFACES does not contain 'leave' or '*'), no adapter
 *   (getAdapter() returns null until the merge), or any adapter error:
 *   callers fall back to the exact current Firestore behaviour.
 * - Flag ON: reads go through the adapter; writes are dual -- Firestore
 *   stays primary and the seam mirrors to Supabase so the mirror never
 *   goes stale. Mirror failures are swallowed (logged) and never change
 *   the Firestore result or the response shape.
 *
 * Timestamp conversions (the leave bug class): Firestore Timestamps come
 * back from jsonb as ISO strings. This seam converts explicitly:
 * - Outbound (Firestore -> Supa): Date / Timestamp-like ({ toDate() }) /
 *   serverTimestamp sentinel values become ISO strings
 *   (serializeValueForSupa / serializeDataForSupa).
 * - Inbound (Supa -> Firestore-shaped): ISO strings in the known leave
 *   timestamp fields become Timestamp-like objects exposing toDate(),
 *   toMillis() and toISOString() (toTimestampLike), for consumers that
 *   call .toDate() (universal-review). The /api/leave serializer accepts
 *   strings, Dates and Timestamp-likes alike, so its responses stay
 *   byte-identical either way.
 */

import {
  getSupaAdapter as getRealSupaAdapter,
  getSupaClient as getRealSupaClient,
} from '@/lib/supa';

export type DocData = Record<string, unknown>;
export type SupaDoc = { id: string } & DocData;

export type WhereOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'array-contains';
export type WhereClause = [field: string, op: WhereOp, value: unknown];

export interface OrderSpec {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface ListOptions {
  where?: WhereClause[];
  orderBy?: string | OrderSpec | OrderSpec[];
  limit?: number;
  startAfter?: string | number;
}

/** Identical to SupaAdapter in src/lib/supa/adapter.ts (feat/supa-adapter). */
export interface SupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(collectionPath: string, options?: ListOptions): Promise<SupaDoc[]>;
  countDocs(collectionPath: string, where?: WhereClause[]): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: DocData,
    options?: { merge?: boolean },
  ): Promise<SupaDoc>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: DocData,
  ): Promise<SupaDoc>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

export const LEAVE_REQUESTS_COLLECTION = 'leave_requests';
export const LEAVE_AUDIT_COLLECTION = 'leave_audit';
export const LEAVE_SURFACE = 'leave';

/* ------------------------------------------------------------ flag gate */
/* Mirrors src/lib/supa/flags.ts (feat/supa-adapter) exactly. */

export function parseSupaSurfaces(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function useSupa(surface: string): boolean {
  const surfaces = parseSupaSurfaces(process.env.SUPA_SURFACES);
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(surface.trim().toLowerCase());
}

/**
 * Mirrors src/lib/supa/client.ts: returns null when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are unset.
 *
 * RE-POINTED (cutover W4): the merge this stub waited for landed long
 * ago (src/lib/supa is in this tree), but the stub was never swapped —
 * so every leave read fell back and every leave mirror silently
 * no-opped in production (the same no-op-flip class as the dead
 * webpackIgnore loaders). It now delegates to the real client factory.
 */
export function getSupaClient(): unknown {
  try {
    return getRealSupaClient();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- adapter access */

let adapterOverride: SupaAdapter | null | undefined;

/**
 * The adapter for this surface, or null when Supabase is not wired.
 * RE-POINTED (cutover W4, see getSupaClient above): delegates to
 * getSupaAdapter() from '@/lib/supa' when a client is configured;
 * unconfigured / any failure resolves to null, preserving this seam's
 * fallback contract (and its default-null behavior in tests, where no
 * Supabase env is configured). Tests inject a fake via
 * setAdapterForTests.
 */
export function getAdapter(): SupaAdapter | null {
  if (adapterOverride !== undefined) return adapterOverride;
  try {
    if (!getRealSupaClient()) return null;
    return getRealSupaAdapter() as unknown as SupaAdapter;
  } catch {
    return null;
  }
}

/** Test-only injection point for a mocked adapter. */
export function setAdapterForTests(adapter: SupaAdapter | null): void {
  adapterOverride = adapter;
}

export function resetAdapterForTests(): void {
  adapterOverride = undefined;
}

/** True only when the flag is ON for 'leave' AND an adapter exists. */
export function isLeaveSupaEnabled(): boolean {
  return useSupa(LEAVE_SURFACE) && getAdapter() !== null;
}

/* ------------------------------------------------- timestamp conversions */

export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toDate: () => Date;
  toMillis: () => number;
  toISOString: () => string;
}

export function toTimestampLike(value: unknown): unknown {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return value;
    const date = new Date(ms);
    return {
      seconds: Math.floor(ms / 1000),
      nanoseconds: (ms % 1000) * 1_000_000,
      toDate: () => new Date(date.getTime()),
      toMillis: () => ms,
      toISOString: () => date.toISOString(),
    } satisfies TimestampLike;
  }
  if (value instanceof Date) {
    return toTimestampLike(value.toISOString());
  }
  return value;
}

function isTimestampLike(value: unknown): value is { toDate: () => Date } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  );
}

function isServerTimestampSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.__sentinel === 'serverTimestamp') return true;
  if (typeof record._methodName === 'string' && record._methodName.includes('serverTimestamp')) {
    return true;
  }
  return false;
}

export function isDeleteSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.__sentinel === 'delete') return true;
  if (typeof record._methodName === 'string' && record._methodName.includes('deleteField')) {
    return true;
  }
  return false;
}

/** One Firestore-side value -> its jsonb representation. */
export function serializeValueForSupa(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (isServerTimestampSentinel(value)) return new Date().toISOString();
  if (isTimestampLike(value)) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValueForSupa);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isDeleteSentinel(inner)) continue;
      out[key] = serializeValueForSupa(inner);
    }
    return out;
  }
  return value;
}

/**
 * A whole document body -> jsonb-ready data. Top-level delete sentinels
 * are dropped (a mirrored update cannot delete via jsonb replace; the
 * Firestore primary already applied the delete).
 */
export function serializeDataForSupa(data: DocData): DocData {
  const out: DocData = {};
  for (const [key, value] of Object.entries(data)) {
    if (isDeleteSentinel(value)) continue;
    out[key] = serializeValueForSupa(value);
  }
  return out;
}

/** Leave request timestamp fields (src/types/leave.ts + return flow). */
export const LEAVE_REQUEST_TIMESTAMP_FIELDS = [
  'createdAt',
  'updatedAt',
  'reviewedAt',
  'revokedAt',
  'returnedAt',
] as const;

/** Leave audit timestamp fields. */
export const LEAVE_AUDIT_TIMESTAMP_FIELDS = ['timestamp'] as const;

export function convertLeaveRequestTimestamps<T extends DocData>(doc: T): T {
  const out: DocData = { ...doc };
  for (const field of LEAVE_REQUEST_TIMESTAMP_FIELDS) {
    if (typeof out[field] === 'string' || out[field] instanceof Date) {
      out[field] = toTimestampLike(out[field]);
    }
  }
  return out as T;
}

export function convertLeaveAuditTimestamps<T extends DocData>(doc: T): T {
  const out: DocData = { ...doc };
  for (const field of LEAVE_AUDIT_TIMESTAMP_FIELDS) {
    if (typeof out[field] === 'string' || out[field] instanceof Date) {
      out[field] = toTimestampLike(out[field]);
    }
  }
  return out as T;
}

/* -------------------------------------------------------------- reading */

export type SupaReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'disabled' }
  | { status: 'error'; error: unknown };

async function readResult<T>(run: (adapter: SupaAdapter) => Promise<T>): Promise<SupaReadResult<T>> {
  const adapter = getAdapter();
  if (!useSupa(LEAVE_SURFACE) || !adapter) return { status: 'disabled' };
  try {
    return { status: 'ok', value: await run(adapter) };
  } catch (error) {
    return { status: 'error', error };
  }
}

/** Raw Supa leave request (timestamps still ISO strings), or a status. */
export function tryGetLeaveRequestRaw(id: string): Promise<SupaReadResult<SupaDoc | null>> {
  return readResult((adapter) => adapter.getDoc(LEAVE_REQUESTS_COLLECTION, id));
}

/** Supa leave request with Timestamp-like timestamp fields. */
export async function tryGetLeaveRequest(id: string): Promise<SupaReadResult<SupaDoc | null>> {
  const result = await tryGetLeaveRequestRaw(id);
  if (result.status !== 'ok' || result.value === null) return result;
  return { status: 'ok', value: convertLeaveRequestTimestamps(result.value) };
}

export function tryListLeaveRequests(
  options?: ListOptions,
): Promise<SupaReadResult<SupaDoc[]>> {
  return readResult(async (adapter) => {
    const docs = await adapter.listDocs(LEAVE_REQUESTS_COLLECTION, options);
    return docs.map((doc) => convertLeaveRequestTimestamps(doc));
  });
}

export function tryGetLeaveAudit(id: string): Promise<SupaReadResult<SupaDoc | null>> {
  return readResult(async (adapter) => {
    const doc = await adapter.getDoc(LEAVE_AUDIT_COLLECTION, id);
    return doc ? convertLeaveAuditTimestamps(doc) : null;
  });
}

export function tryListLeaveAudit(options?: ListOptions): Promise<SupaReadResult<SupaDoc[]>> {
  return readResult(async (adapter) => {
    const docs = await adapter.listDocs(LEAVE_AUDIT_COLLECTION, options);
    return docs.map((doc) => convertLeaveAuditTimestamps(doc));
  });
}

/* ------------------------------------------- universal-review readers */
/* src/app/api/admin/universal-review/route.ts is shared with other
 * clusters and is NOT edited by this branch. These are the supa-backed
 * leave readers it will consume at merge time (wiring spec in the
 * implementer report). They return Firestore-shaped docs whose
 * timestamp fields are Timestamp-like, matching what that route does
 * with .toDate() today. */

/** GET-side reader: list leave requests by status, newest first. */
export function listLeaveRequestsForReview(options?: {
  status?: string;
  limit?: number;
}): Promise<SupaReadResult<SupaDoc[]>> {
  const where: WhereClause[] = [];
  if (options?.status && options.status !== 'all') {
    where.push(['status', '==', options.status]);
  }
  return tryListLeaveRequests({
    where: where.length > 0 ? where : undefined,
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: options?.limit ?? 100,
  });
}

/** PATCH-side reader (generic approve/reject loop + revoke branch). */
export function getLeaveRequestForReview(id: string): Promise<SupaReadResult<SupaDoc | null>> {
  return tryGetLeaveRequest(id);
}

/* -------------------------------------------------------------- writing */
/* Dual-write mirrors: Firestore is written first by the caller; these
 * mirror the same change to Supabase. They never throw. */

async function mirror(run: (adapter: SupaAdapter) => Promise<unknown>): Promise<boolean> {
  const adapter = getAdapter();
  if (!useSupa(LEAVE_SURFACE) || !adapter) return false;
  try {
    await run(adapter);
    return true;
  } catch (error) {
    console.error('[hr-leave seam] Supabase mirror failed; Firestore remains primary:', error);
    return false;
  }
}

export function mirrorLeaveRequestSet(id: string, data: DocData): Promise<boolean> {
  const serialized = serializeDataForSupa(data);
  return mirror((adapter) => adapter.setDoc(LEAVE_REQUESTS_COLLECTION, id, serialized));
}

export function mirrorLeaveRequestUpdate(id: string, updates: DocData): Promise<boolean> {
  const serialized = serializeDataForSupa(updates);
  return mirror((adapter) => adapter.updateDoc(LEAVE_REQUESTS_COLLECTION, id, serialized));
}

export function mirrorLeaveRequestDelete(id: string): Promise<boolean> {
  return mirror((adapter) => adapter.deleteDoc(LEAVE_REQUESTS_COLLECTION, id));
}

export function mirrorLeaveAuditSet(id: string, data: DocData): Promise<boolean> {
  const serialized = serializeDataForSupa(data);
  return mirror((adapter) => adapter.setDoc(LEAVE_AUDIT_COLLECTION, id, serialized));
}

/* ------------------------------------------------------------- primacy */
/* WRITE PRIMACY (cutover W4, route half only): isLeaveSupaPrimary
 * mirrors isSupaPrimary('leave') in src/lib/supa/flags.ts with this
 * seam's local parser (token in BOTH SUPA_SURFACES and SUPA_PRIMARY).
 * PrimaryFirst helpers write the adapter FIRST and THROW on failure;
 * the caller then runs its Firestore write as the best-effort
 * post-commit mirror. OFF (default): return false, today's
 * Firestore-first flow + mirror runs byte-identically.
 * SCOPE: only the /api/leave route's standalone create + cancel use
 * these. leave-return.ts and restore-workload are Firestore batches
 * (leave + audit + users flags) and stay mirror-only — the 'leave'
 * token must not flip until they convert (w4-census.md). */

export function isLeaveSupaPrimary(): boolean {
  if (!useSupa(LEAVE_SURFACE)) return false;
  const parts = parseSupaSurfaces(process.env.SUPA_PRIMARY);
  return parts.has('*') || parts.has(LEAVE_SURFACE);
}

export async function setLeaveRequestPrimaryFirst(id: string, data: DocData): Promise<boolean> {
  if (!isLeaveSupaPrimary()) return false;
  const adapter = getAdapter();
  if (!adapter) return false;
  await adapter.setDoc(LEAVE_REQUESTS_COLLECTION, id, serializeDataForSupa(data));
  return true;
}

export async function updateLeaveRequestPrimaryFirst(id: string, updates: DocData): Promise<boolean> {
  if (!isLeaveSupaPrimary()) return false;
  const adapter = getAdapter();
  if (!adapter) return false;
  await adapter.updateDoc(LEAVE_REQUESTS_COLLECTION, id, serializeDataForSupa(updates));
  return true;
}
