/**
 * applications-supa.ts — the ONE Supabase seam for group APPS-1
 * (applications SERVER data paths):
 *
 *   - src/app/api/chapter-applications/route.ts        (chapter_applications)
 *   - src/app/api/applications/status/route.ts          (applications)
 *   - src/app/actions/chapter-applications.ts           (chapter_applications
 *     create / status transitions, plus the approval-time chapters create)
 *
 * Every Supabase touch for those files lives in this module. The route and
 * action files contain no adapter references; they only call the helpers
 * below. Cross-seam ports owned by sibling groups are declared here as
 * LOCAL interfaces and flagged for the merge step:
 *
 *   - ChaptersWriterPort  -> APPS-3's src/lib/chapters-supa.ts. Approval of
 *     a chapter application CREATES a document in `chapters` (slug-keyed).
 *     Until APPS-3's seam lands, the default port implementation is backed
 *     by the same Supabase adapter over the `chapters` collection.
 *   - CadetshipsReadPort  -> APPS-4's src/lib/cadetships-supa.ts. The
 *     applications/status route reads `cadetships` (personUid == uid,
 *     limit 5). Until APPS-4's seam lands, the default port implementation
 *     is backed by the same adapter over the `cadetships` collection.
 *
 * Behavior contract (identical for every consumer):
 * - Flag OFF (default), adapter absent/unconfigured, or adapter load
 *   failure -> resolveApplicationsSupaAdapter() returns null and every
 *   consumer runs EXACTLY today's Firestore code path, byte-identical
 *   response shapes and status codes.
 * - Flag ON + adapter present -> pure reads (list/detail/lookups) are
 *   served from the fs_* tables through this seam; writes stay on
 *   Firestore (primary) and are mirrored here. Mirror helpers NEVER
 *   throw: a mirror failure is logged and the request proceeds.
 * - A read helper that throws (adapter error) is caught by the caller,
 *   which falls back to its Firestore path.
 *
 * The real adapter (src/lib/supa/, branch feat/supa-adapter) is NOT in
 * this tree. It is reached through a lazy dynamic import with a variable
 * specifier so tsc stays clean on this base, typed against the locally
 * declared ApplicationsSupaAdapter interface, which mirrors the real
 * adapter's signatures (getDoc/listDocs/countDocs/setDoc/updateDoc/
 * deleteDoc over fs_<collection> tables; docs come back as
 * { id, ...data } plain objects). MERGE-TIME RE-POINT: change the one
 * specifier in loadAdapterModule() to '@/lib/supa' and (optionally) swap
 * applicationsSupaEnabled() for the adapter's useSupa('applications').
 *
 * Timestamp reality of the fs_* jsonb columns: Firestore Timestamp
 * objects do not survive JSON. Stored values come back as ISO strings
 * (this module's mirror writes, and the migration dump for most fields),
 * Admin-SDK dump objects ({ _seconds, _nanoseconds } / { seconds,
 * nanoseconds }), or epoch numbers. Consumers of chapter_applications
 * call .toDate() on createdAt/updatedAt/reviewedAt and the status route
 * sorts cadetships by startedAt.toMillis(), so seam-served docs get
 * those fields wrapped in a Firestore-Timestamp-shaped value
 * (SeamTimestamp) implementing exactly that surface. Consumers that go
 * through src/lib/applicant-status.ts normalizeTimestamp() accept ISO
 * strings natively and need no wrapping.
 */

import { getSupaAdapter, getSupaClient } from '@/lib/supa';

// ---------------------------------------------------------------------------
// Surface flag (re-point at the adapter's useSupa('applications') at merge)
// ---------------------------------------------------------------------------

export const APPLICATIONS_SUPA_SURFACE = 'applications';

export const CHAPTER_APPLICATIONS_COLLECTION = 'chapter_applications';
export const APPLICATIONS_COLLECTION = 'applications';
export const CHAPTERS_COLLECTION = 'chapters';
export const CADETSHIPS_COLLECTION = 'cadetships';

/**
 * useSupa('applications') equivalent for this tree: SUPA_SURFACES is a
 * comma-separated surface list; '*' enables every surface; matching is
 * case-insensitive; unset/empty means OFF (the default).
 */
export function applicationsSupaEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes(APPLICATIONS_SUPA_SURFACE);
}

// ---------------------------------------------------------------------------
// Adapter contract (local structural interface; mirrors src/lib/supa)
// ---------------------------------------------------------------------------

export type SupaWhereClause = [field: string, op: string, value: any];

export interface SupaListOptions {
  where?: SupaWhereClause[];
  orderBy?: string | { field: string; direction?: 'asc' | 'desc' } | Array<{ field: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  startAfter?: string | number;
}

export interface ApplicationsSupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<Record<string, any> | null>;
  listDocs(collectionPath: string, options?: SupaListOptions): Promise<Array<Record<string, any>>>;
  countDocs(collectionPath: string, where?: SupaWhereClause[]): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, any>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
  updateDoc(collectionPath: string, id: string, updates: Record<string, any>): Promise<unknown>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter resolution (lazy, cached, test-injectable)
// ---------------------------------------------------------------------------

let injectedAdapter: ApplicationsSupaAdapter | null | undefined;
let adapterPromise: Promise<ApplicationsSupaAdapter | null> | null = null;

/** Test-only: inject a mocked adapter (or null to simulate absence). */
export function __setApplicationsSupaAdapterForTests(
  adapter: ApplicationsSupaAdapter | null,
): void {
  injectedAdapter = adapter;
  adapterPromise = null;
}

/** Test-only: clear injection and the cached adapter promise. */
export function __resetApplicationsSupaAdapterForTests(): void {
  injectedAdapter = undefined;
  adapterPromise = null;
}

async function loadAdapterModule(): Promise<ApplicationsSupaAdapter | null> {
  // STATIC import (live-defect fix): the previous webpackIgnore dynamic
  // import of the '@/lib/supa' alias never resolved in the standalone
  // server bundle, so this loader always failed in production.
  // SUPA_ADAPTER_SPECIFIER is REMOVED: it cannot be honored by a static
  // import, and it was unset in production (tests use the injection
  // points above instead).
  try {
    // Real adapter shape: a factory pair. The client check is half the
    // gate — flag ON with Supabase unconfigured must stay on Firestore.
    if (typeof getSupaAdapter === 'function') {
      if (typeof getSupaClient === 'function' && !getSupaClient()) {
        return null;
      }
      const candidate: any = getSupaAdapter();
      if (
        candidate &&
        typeof candidate.getDoc === 'function' &&
        typeof candidate.listDocs === 'function' &&
        typeof candidate.setDoc === 'function'
      ) {
        return candidate as ApplicationsSupaAdapter;
      }
    }
    // (The old bare-adapter fallback over the module namespace has no
    // static equivalent and no production consumer: the real module's
    // only data shape is the factory above; unit fakes arrive through
    // __setApplicationsSupaAdapterForTests.)
    console.warn(
      '[applications-supa] Adapter module loaded but does not match the contract; staying on Firestore',
    );
    return null;
  } catch (err) {
    // Absent or unconfigured adapter is an expected state in this wave:
    // consumers keep their exact Firestore behavior.
    console.warn(
      '[applications-supa] Adapter unavailable; staying on Firestore',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Resolve the adapter for the applications surface, or null when the
 * surface flag is OFF, the adapter is absent/unconfigured, or loading it
 * failed. Returning null always means: use the Firestore path, unchanged.
 */
export async function resolveApplicationsSupaAdapter(): Promise<ApplicationsSupaAdapter | null> {
  if (!applicationsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (!adapterPromise) adapterPromise = loadAdapterModule();
  return adapterPromise;
}

// ---------------------------------------------------------------------------
// Timestamps: jsonb values -> Firestore-Timestamp-shaped values
// ---------------------------------------------------------------------------

export interface SeamTimestamp {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
  toISOString(): string;
}

export function makeSeamTimestamp(ms: number): SeamTimestamp {
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = Math.round((ms - seconds * 1000) * 1e6);
  return {
    seconds,
    nanoseconds,
    toMillis: () => ms,
    toDate: () => new Date(ms),
    toISOString: () => new Date(ms).toISOString(),
  };
}

/**
 * Normalize any stored timestamp representation to epoch millis, or null
 * when the value carries no usable date. Accepts ISO strings, epoch
 * numbers, Dates, Timestamp-like objects (toDate()/toMillis()), and the
 * Admin SDK JSON shapes { _seconds, _nanoseconds } / { seconds,
 * nanoseconds }.
 */
export function supaTimestampMillis(value: any): number | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    if (typeof value === 'object') {
      if (typeof value.toMillis === 'function') {
        const ms = value.toMillis();
        return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
      }
      if (typeof value.toDate === 'function') {
        const d = value.toDate();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
      }
      const seconds = value._seconds ?? value.seconds;
      if (typeof seconds === 'number') {
        const nanos = value._nanoseconds ?? value.nanoseconds ?? 0;
        return seconds * 1000 + Math.floor(nanos / 1e6);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Wrap a stored timestamp value in a SeamTimestamp, or return it as-is. */
export function toSeamTimestamp(value: any): any {
  if (value === null || value === undefined) return value;
  // Already Timestamp-shaped (has toDate): leave untouched.
  if (typeof value === 'object' && typeof value.toDate === 'function' && !(value instanceof Date)) {
    return value;
  }
  const ms = supaTimestampMillis(value);
  return ms === null ? value : makeSeamTimestamp(ms);
}

/**
 * Return a shallow copy of `data` with the named timestamp fields wrapped
 * as SeamTimestamps, so consumers calling .toDate()/.toMillis() run
 * unchanged on jsonb-sourced docs.
 */
export function restoreTimestampFields<T extends Record<string, any>>(
  data: T,
  fields: readonly string[],
): T {
  const out: Record<string, any> = { ...data };
  for (const field of fields) {
    if (out[field] !== undefined && out[field] !== null) {
      out[field] = toSeamTimestamp(out[field]);
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Mirror-write serialization (Firestore values -> jsonb values)
// ---------------------------------------------------------------------------

/** Marker for a FieldValue.delete() equivalent inside a mirror payload. */
export const SUPA_DELETE_FIELD: unique symbol = Symbol('applications-supa.deleteField');

function sentinelMethodName(value: any): string | null {
  if (value === null || typeof value !== 'object') return null;
  // Admin SDK FieldValue subclasses expose a `methodName` getter
  // ('FieldValue.serverTimestamp', 'FieldValue.delete', ...); the web
  // SDK uses `_methodName`; unit-test fakes in this repo use `__fv`.
  try {
    if (typeof value.methodName === 'string') return value.methodName;
  } catch {
    /* getter threw — not a sentinel */
  }
  if (typeof value._methodName === 'string') return value._methodName;
  if (typeof value.__fv === 'string') return value.__fv;
  return null;
}

function isServerTimestampSentinel(value: any): boolean {
  const name = sentinelMethodName(value);
  return name === 'FieldValue.serverTimestamp' || name === 'serverTimestamp';
}

function isDeleteSentinel(value: any): boolean {
  if (value === SUPA_DELETE_FIELD) return true;
  const name = sentinelMethodName(value);
  return name === 'FieldValue.delete' || name === 'deleteField' || name === 'delete';
}

/**
 * Deep-convert a Firestore-bound document/update into its jsonb form:
 *  - Timestamp-like values (toDate()) and Dates -> ISO strings
 *  - { _seconds, _nanoseconds } / { seconds, nanoseconds } -> ISO strings
 *  - serverTimestamp() sentinels -> the current instant as an ISO string
 *    (Firestore resolves its own sentinel server-side on the primary
 *    write; the mirror stamps the client's instant for the same write,
 *    so the two can differ by sub-second clock skew — Firestore stays
 *    primary)
 *  - delete() sentinels / SUPA_DELETE_FIELD -> the SUPA_DELETE_FIELD
 *    marker (interpreted by mirrorUpdateDoc; dropped by mirrorSetDoc)
 *  - everything else recurses (plain objects, arrays) or passes through.
 */
export function serializeForSupa(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (isDeleteSentinel(value)) return SUPA_DELETE_FIELD;
  if (isServerTimestampSentinel(value)) return new Date().toISOString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
    } catch {
      return null;
    }
  }
  const seconds = value._seconds ?? value.seconds;
  if (typeof seconds === 'number' && Object.keys(value).length <= 3) {
    const nanos = value._nanoseconds ?? value.nanoseconds ?? 0;
    return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
  }
  if (Array.isArray(value)) return value.map(serializeForSupa);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = serializeForSupa(v);
  return out;
}

// ---------------------------------------------------------------------------
// Reads (throw on adapter error — callers fall back to Firestore)
// ---------------------------------------------------------------------------

export const CHAPTER_APPLICATION_TIMESTAMP_FIELDS = [
  'createdAt',
  'updatedAt',
  'reviewedAt',
] as const;

/**
 * chapter_applications list for GET /api/chapter-applications:
 * orderBy createdAt desc, limit 100, optional status filter ('all' or
 * null/undefined means no filter — same as the Firestore query).
 * Returned docs are { id, ...data } with createdAt/updatedAt/reviewedAt
 * wrapped as SeamTimestamps, matching what the route's mapping expects
 * from Firestore docs.
 */
export async function listChapterApplications(
  adapter: ApplicationsSupaAdapter,
  statusFilter: string | null | undefined,
): Promise<Array<Record<string, any>>> {
  const options: SupaListOptions = {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 100,
  };
  if (statusFilter && statusFilter !== 'all') {
    options.where = [['status', '==', statusFilter]];
  }
  const docs = await adapter.listDocs(CHAPTER_APPLICATIONS_COLLECTION, options);
  return docs.map((doc) => {
    const { id, ...data } = doc;
    return { id, ...restoreTimestampFields(data, CHAPTER_APPLICATION_TIMESTAMP_FIELDS) };
  });
}

/**
 * One chapter_applications doc by id ({ id, ...data }, timestamps
 * restored), or null when the fs table has no such row.
 */
export async function getChapterApplication(
  adapter: ApplicationsSupaAdapter,
  id: string,
): Promise<Record<string, any> | null> {
  const doc = await adapter.getDoc(CHAPTER_APPLICATIONS_COLLECTION, id);
  if (!doc) return null;
  const { id: docId, ...data } = doc;
  return { id: docId, ...restoreTimestampFields(data, CHAPTER_APPLICATION_TIMESTAMP_FIELDS) };
}

/**
 * One applications doc by uid (the doc id), as a raw record for
 * src/lib/applicant-status.ts (its normalizeTimestamp accepts the ISO
 * strings jsonb returns), or null when absent.
 */
export async function getApplicationRecord(
  adapter: ApplicationsSupaAdapter,
  uid: string,
): Promise<Record<string, any> | null> {
  const doc = await adapter.getDoc(APPLICATIONS_COLLECTION, uid);
  if (!doc) return null;
  const { id: _id, ...data } = doc;
  void _id;
  return data;
}

/**
 * applications docs matching an email (limit 5), as { id, ...data } —
 * the POST /api/applications/status reference+email lookup.
 */
export async function findApplicationDocsByEmail(
  adapter: ApplicationsSupaAdapter,
  email: string,
): Promise<Array<Record<string, any>>> {
  return adapter.listDocs(APPLICATIONS_COLLECTION, {
    where: [['email', '==', email]],
    limit: 5,
  });
}

// ---------------------------------------------------------------------------
// Cross-seam port: cadetships reads (APPS-4 owns src/lib/cadetships-supa.ts)
// ---------------------------------------------------------------------------

/**
 * LOCAL INTERFACE for the APPS-4 cadetships seam. The status route reads
 * cadetships through this port only — never through its own table logic.
 * At merge time the default implementation below is replaced by APPS-4's
 * seam export; the port shape stays.
 */
export interface CadetshipsReadPort {
  listForPerson(
    adapter: ApplicationsSupaAdapter,
    personUid: string,
    limit: number,
  ): Promise<Array<Record<string, any>>>;
}

const defaultCadetshipsReadPort: CadetshipsReadPort = {
  async listForPerson(adapter, personUid, limit) {
    const docs = await adapter.listDocs(CADETSHIPS_COLLECTION, {
      where: [['personUid', '==', personUid]],
      limit,
    });
    // The status route sorts by startedAt.toMillis(); from jsonb that
    // field is an ISO string, so restore it to a SeamTimestamp here.
    return docs.map((doc) => {
      const { id: _id, ...data } = doc;
      void _id;
      return restoreTimestampFields(data, ['startedAt']);
    });
  },
};

let cadetshipsReadPort: CadetshipsReadPort = defaultCadetshipsReadPort;

/** Test-only: swap the cadetships port implementation. */
export function __setCadetshipsReadPortForTests(port: CadetshipsReadPort): void {
  cadetshipsReadPort = port;
}

/** Test-only: restore the default cadetships port. */
export function __resetCadetshipsReadPortForTests(): void {
  cadetshipsReadPort = defaultCadetshipsReadPort;
}

/**
 * Cadetship docs (raw data, startedAt restored) for the status route.
 * Returns null when Supa is unavailable for this surface (flag OFF /
 * adapter absent) AND on adapter error — the caller then runs its
 * existing Firestore lookup, whose own try/catch preserves the current
 * degrade-to-no-cadetship-block behavior.
 */
export async function tryListCadetshipsForPerson(
  personUid: string,
  limit = 5,
): Promise<Array<Record<string, any>> | null> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return null;
  try {
    return await cadetshipsReadPort.listForPerson(adapter, personUid, limit);
  } catch (err) {
    console.error('[applications-supa] cadetships read failed; falling back to Firestore', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-seam port: chapters writes (APPS-3 owns src/lib/chapters-supa.ts)
// ---------------------------------------------------------------------------

/**
 * LOCAL INTERFACE for the APPS-3 chapters seam. Chapter-application
 * approval creates a slug-keyed document in `chapters`; that write goes
 * through this port only. At merge time the default implementation below
 * (backed by the shared adapter over the `chapters` collection) is
 * replaced by APPS-3's seam export; the port shape stays.
 */
export interface ChaptersWriterPort {
  /** Chapter doc data by id, or null when absent. */
  getChapter(
    adapter: ApplicationsSupaAdapter,
    id: string,
  ): Promise<Record<string, any> | null>;
  /** Create/replace the chapter row (mirror of the Firestore set). */
  setChapter(
    adapter: ApplicationsSupaAdapter,
    id: string,
    data: Record<string, any>,
  ): Promise<void>;
  /** Remove the chapter row (mirror of the Firestore delete). */
  deleteChapter(adapter: ApplicationsSupaAdapter, id: string): Promise<void>;
}

const defaultChaptersWriterPort: ChaptersWriterPort = {
  async getChapter(adapter, id) {
    const doc = await adapter.getDoc(CHAPTERS_COLLECTION, id);
    if (!doc) return null;
    const { id: _id, ...data } = doc;
    void _id;
    return data;
  },
  async setChapter(adapter, id, data) {
    await adapter.setDoc(CHAPTERS_COLLECTION, id, serializeForSupa(data));
  },
  async deleteChapter(adapter, id) {
    await adapter.deleteDoc(CHAPTERS_COLLECTION, id);
  },
};

let chaptersWriterPort: ChaptersWriterPort = defaultChaptersWriterPort;

/** Test-only: swap the chapters writer port implementation. */
export function __setChaptersWriterPortForTests(port: ChaptersWriterPort): void {
  chaptersWriterPort = port;
}

/** Test-only: restore the default chapters writer port. */
export function __resetChaptersWriterPortForTests(): void {
  chaptersWriterPort = defaultChaptersWriterPort;
}

/**
 * Whether a chapter doc exists in the fs_chapters table. Returns null
 * when Supa is unavailable or the read fails — the caller then runs its
 * Firestore existence check, unchanged.
 */
export async function chapterExistsViaSupa(id: string): Promise<boolean | null> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return null;
  try {
    const doc = await chaptersWriterPort.getChapter(adapter, id);
    return doc !== null;
  } catch (err) {
    console.error('[applications-supa] chapter existence check failed; falling back to Firestore', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mirror writes (NEVER throw — Firestore is primary)
// ---------------------------------------------------------------------------

/** Mirror a full-document set into fs_<collection>. Returns success. */
export async function mirrorSetDoc(
  collection: string,
  id: string,
  data: Record<string, any>,
): Promise<boolean> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return false;
  try {
    const serialized = serializeForSupa(data) as Record<string, any>;
    // A delete marker has no meaning in a full-document set; drop the key.
    for (const key of Object.keys(serialized)) {
      if (serialized[key] === SUPA_DELETE_FIELD) delete serialized[key];
    }
    await adapter.setDoc(collection, id, serialized);
    return true;
  } catch (err) {
    console.error(`[applications-supa] mirror set failed for ${collection}/${id}`, err);
    return false;
  }
}

function setDeep(target: Record<string, any>, parts: string[], value: any): void {
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    const next =
      child !== null && typeof child === 'object' && !Array.isArray(child)
        ? { ...child }
        : {};
    cursor[part] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
}

function deleteDeep(target: Record<string, any>, parts: string[]): void {
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    if (child === null || typeof child !== 'object') return;
    cursor = child as Record<string, any>;
  }
  delete cursor[parts[parts.length - 1]];
}

/**
 * Mirror a partial update into fs_<collection> as read-modify-write
 * (the adapter's updateDoc would store sentinel objects verbatim, so
 * the seam serializes first and applies dot-path keys and delete
 * markers itself). Returns false — writing nothing — when the row does
 * not exist: a partial-only row would surface in reads missing its
 * other fields, which is worse than a stale mirror; the migration
 * refresh heals such rows.
 */
export async function mirrorUpdateDoc(
  collection: string,
  id: string,
  updates: Record<string, any>,
): Promise<boolean> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return false;
  try {
    const existing = await adapter.getDoc(collection, id);
    if (!existing) return false;
    const { id: _existingId, ...existingData } = existing;
    void _existingId;
    const next: Record<string, any> = { ...existingData };
    const serialized = serializeForSupa(updates) as Record<string, any>;
    for (const [key, value] of Object.entries(serialized)) {
      const parts = key.split('.');
      if (value === SUPA_DELETE_FIELD) {
        deleteDeep(next, parts);
      } else {
        setDeep(next, parts, value);
      }
    }
    await adapter.setDoc(collection, id, next);
    return true;
  } catch (err) {
    console.error(`[applications-supa] mirror update failed for ${collection}/${id}`, err);
    return false;
  }
}

/** Mirror a document delete into fs_<collection>. Returns success. */
export async function mirrorDeleteDoc(collection: string, id: string): Promise<boolean> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return false;
  try {
    await adapter.deleteDoc(collection, id);
    return true;
  } catch (err) {
    console.error(`[applications-supa] mirror delete failed for ${collection}/${id}`, err);
    return false;
  }
}

// Convenience wrappers naming the APPS-1 collections.

export function mirrorChapterApplicationSet(id: string, data: Record<string, any>): Promise<boolean> {
  return mirrorSetDoc(CHAPTER_APPLICATIONS_COLLECTION, id, data);
}

export function mirrorChapterApplicationUpdate(
  id: string,
  updates: Record<string, any>,
): Promise<boolean> {
  return mirrorUpdateDoc(CHAPTER_APPLICATIONS_COLLECTION, id, updates);
}

export function mirrorApplicationUpdate(uid: string, updates: Record<string, any>): Promise<boolean> {
  return mirrorUpdateDoc(APPLICATIONS_COLLECTION, uid, updates);
}

/** Mirror the approval-time chapters create (via the APPS-3 port). */
export async function mirrorChapterSet(id: string, data: Record<string, any>): Promise<boolean> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return false;
  try {
    await chaptersWriterPort.setChapter(adapter, id, data);
    return true;
  } catch (err) {
    console.error(`[applications-supa] mirror chapter set failed for ${id}`, err);
    return false;
  }
}

/** Mirror the chapters delete in deleteChapterWithCleanup (via the port). */
export async function mirrorChapterDelete(id: string): Promise<boolean> {
  const adapter = await resolveApplicationsSupaAdapter();
  if (!adapter) return false;
  try {
    await chaptersWriterPort.deleteChapter(adapter, id);
    return true;
  } catch (err) {
    console.error(`[applications-supa] mirror chapter delete failed for ${id}`, err);
    return false;
  }
}
