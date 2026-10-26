/**
 * seam-tasks-lists.ts — the ONE seam module for the tasks cluster group 2
 * (secondary task routes):
 *   src/app/api/tasks/team/route.ts
 *   src/app/api/tasks/review-queue/route.ts
 *   src/app/api/tasks/approval-rate/route.ts
 *   src/app/api/tasks/[id]/activity/route.ts
 *   src/app/api/tasks/[id]/validation/route.ts
 *
 * Route files call only this seam; nothing else in the group references the
 * Supabase adapter directly.
 *
 * Contract:
 * - Surface string is exactly 'tasks'.
 * - Flag OFF (SUPA_SURFACES does not name 'tasks'), adapter module absent, or
 *   adapter error: every read helper returns null and the caller falls back
 *   to EXACTLY today's Firestore path (byte-identical shapes/status codes).
 * - Flag ON: reads come from the adapter (Firestore-shaped {id, ...data}
 *   over fs_<collection> jsonb tables). Writes stay on Firestore; the
 *   activity route mirrors its writes through mirrorSetViaSeam(), and a
 *   mirror failure never fails the request.
 * - The validation route has NO write path of its own (GET-only capability
 *   check; the decision writes live in the group-1 tasks route and the
 *   universal-review route, outside this group).
 *
 * The adapter (src/lib/supa/, built on a parallel branch) is NOT present in
 * this base tree, so it is reached through a lazy dynamic import via a
 * variable specifier typed against the locally declared SupaAdapterLike
 * interface below. That keeps tsc clean while the module is absent and
 * resolves to null when unavailable.
 * MERGE-TIME RE-POINT: once src/lib/supa/index.ts lands it must export
 * getSupaAdapter() and useSupa(surface) with the shapes declared here;
 * no seam code change should be needed (see supa-rebase-notes/tasks-2.md).
 *
 * Timestamp normalization: jsonb delivers Firestore timestamps as ISO
 * strings (or {seconds, nanoseconds} objects). Route code in this group
 * calls .toDate() on top-level fields, so every doc the seam returns has
 * its known timestamp fields re-wrapped as Timestamp-like objects with a
 * working .toDate(). String fields that are NOT timestamps are untouched,
 * and nested objects are left as-is (matching what the routes consume).
 *
 * GAP-T2-02 — CLOSED (cutover program, feat/supa-cut-tasks; ratified by
 * Zubair's Option A order, the ratification DEPLOY_READY_REPORT asked
 * for). This seam previously forwarded list options with NO bound: the
 * approval-rate legs issued `adapter.listDocs('tasks', { where })` with
 * no limit, and every caller of listDocsViaSeam/listTasksViaSeam
 * inherited the exposure. Decision, from the real call sites:
 *
 * - EVERY unbounded-by-shape caller filters to a bounded set by
 *   construction, never to the whole collection:
 *     * getApprovalRateViaSeam: three legs, each a single-user clause
 *       (assigneeId == uid / assigneeIds array-contains uid /
 *       submittedBy == uid). The full per-user set is the computation's
 *       input (the last-10 window is selected AFTER the union), so a
 *       small cap would silently truncate the window and CREATE drift.
 *     * team route legs (listTasksViaSeam): assigneeId IN a chunk of at
 *       most 10 member ids, assigneeIds array-contains ONE uid,
 *       assignerId == / createdBy == ONE uid.
 *     * team route subordinate BFS (listDocsViaSeam): managerId IN a
 *       chunk of at most 10 ids, depth capped at 10 in the route.
 *     * review-queue and activity callers already pass explicit limits
 *       (100).
 * - Therefore the seam enforces a stated per-leg bound,
 *   TASKS_LISTS_LEG_BOUND, applied whenever a caller supplies no limit
 *   (an explicit caller limit always wins). The bound is sized to the
 *   largest legitimate leg: a single user's (or a 10-member chunk's)
 *   task set. The reconciled dump holds 23 task docs TOTAL, so 5000 is
 *   more than 200x the entire collection; a leg can only reach it if
 *   one user/chunk legitimately owns 5000 tasks, at which point the
 *   truncation is per-leg, pre-union, and stated here — never silent.
 * - Bound semantics (pinned by tests): the bound applies PER LEG,
 *   BEFORE the caller's in-memory union/dedupe/filter. It is not a
 *   page size and not a post-filter guarantee.
 *
 * Write primacy (cutover): when isSupaPrimary('tasks') is true,
 * writeDocPrimaryFirst() writes the adapter FIRST and throws on
 * failure (the caller must fail the request rather than report success
 * against a stale primary); the caller's Firestore write then runs as
 * the post-commit mirror, best-effort. With SUPA_PRIMARY unset, every
 * behavior in this file is exactly the pre-cutover dual-write behavior.
 */

import { DEFAULT_ROLE_SCOPES } from '@/config/permission-registry';
import { resolveUserScope } from '@/lib/roles';
import { RESTRICTED_NO_CHAPTER } from '@/lib/scope';

/* ------------------------------------------------------------ adapter types */

export type SupaWhereClause = [field: string, op: string, value: unknown];

export interface SupaOrderSpec {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface SupaListOptions {
  where?: SupaWhereClause[];
  orderBy?: string | SupaOrderSpec | SupaOrderSpec[];
  limit?: number;
  startAfter?: string | number;
}

export type SupaDoc = { id: string } & Record<string, unknown>;

/** Locally declared mirror of the adapter contract (src/lib/supa). */
export interface SupaAdapterLike {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(collectionPath: string, options?: SupaListOptions): Promise<SupaDoc[]>;
  countDocs(collectionPath: string, where?: SupaWhereClause[]): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<SupaDoc>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<SupaDoc>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

interface SupaModuleLike {
  getSupaAdapter?: () => SupaAdapterLike;
  useSupa?: (surface: string) => boolean;
  isSupaPrimary?: (surface: string) => boolean;
}

export const TASKS_SUPA_SURFACE = 'tasks';

/* --------------------------------------------------------- adapter loading */

type SupaLoader = () => Promise<SupaModuleLike | null>;

let loaderOverride: SupaLoader | null = null;
let cachedModule: Promise<SupaModuleLike | null> | null = null;

const defaultLoader: SupaLoader = async () => {
  try {
    // Statically bound at step 17 (the adapter is in this tree now): a
    // literal dynamic import keeps the service-role client out of the
    // browser bundle while letting the bundler resolve the module.
    const mod = (await import('@/lib/supa')) as unknown as SupaModuleLike;
    return mod && typeof mod === 'object' ? mod : null;
  } catch {
    return null;
  }
};

function loadSupaModule(): Promise<SupaModuleLike | null> {
  if (loaderOverride) return loaderOverride();
  if (!cachedModule) cachedModule = defaultLoader();
  return cachedModule;
}

/** Test-only: inject a fake adapter module (or null) and reset the cache. */
export function __setSupaLoaderForTests(loader: SupaLoader | null): void {
  loaderOverride = loader;
  cachedModule = null;
}

/** Local fallback for the flag, mirroring src/lib/supa/flags.ts semantics. */
function localUseSupa(surface: string): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes(surface.trim().toLowerCase());
}

/**
 * The adapter when the 'tasks' surface is ON and the module is available;
 * null otherwise (flag OFF / module absent / adapter factory throws).
 * Adapter operation errors are handled by the individual helpers below.
 */
export async function getTasksSupaAdapter(): Promise<SupaAdapterLike | null> {
  const mod = await loadSupaModule();
  if (!mod) return null;
  try {
    const enabled =
      typeof mod.useSupa === 'function'
        ? mod.useSupa(TASKS_SUPA_SURFACE)
        : localUseSupa(TASKS_SUPA_SURFACE);
    if (!enabled) return null;
    if (typeof mod.getSupaAdapter !== 'function') return null;
    return mod.getSupaAdapter();
  } catch {
    return null;
  }
}

/* ------------------------------------------------- timestamp normalization */

const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
  'deadline',
  'individualDeadline',
  'submittedAt',
  'completedAt',
  'approvedAt',
  'rejectedAt',
  'reviewedAt',
  'decidedAt',
  'timestamp',
]);

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export interface TimestampLike {
  toDate: () => Date;
  seconds: number;
  nanoseconds: number;
}

function timestampLikeFromDate(d: Date): TimestampLike {
  const ms = d.getTime();
  return {
    toDate: () => new Date(ms),
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
  };
}

/**
 * Wrap a jsonb timestamp value the way Firestore would deliver it:
 * ISO strings and {seconds, nanoseconds} objects become Timestamp-like;
 * anything else (including values that already have .toDate) passes through.
 */
export function asTimestampLike(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') {
    if (typeof (value as { toDate?: unknown }).toDate === 'function') return value;
    const rec = value as Record<string, unknown>;
    if (typeof rec.seconds === 'number') {
      const ms = rec.seconds * 1000 + Math.floor((Number(rec.nanoseconds) || 0) / 1e6);
      return timestampLikeFromDate(new Date(ms));
    }
    return value;
  }
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return timestampLikeFromDate(d);
  }
  return value;
}

/** Normalize the known top-level timestamp fields of one adapter doc. */
export function normalizeDocData<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = { ...data };
  for (const field of TIMESTAMP_FIELDS) {
    if (field in out) out[field] = asTimestampLike(out[field]);
  }
  return out as T;
}

/* ------------------------------------------------------- Firestore shapes */

export interface SeamDocSnap {
  id: string;
  exists: boolean;
  data: () => Record<string, any> | undefined;
}

export interface SeamQuerySnap {
  docs: SeamDocSnap[];
  empty: boolean;
  size: number;
}

function toDocSnap(doc: SupaDoc): SeamDocSnap {
  const { id, ...rest } = doc;
  const data = normalizeDocData(rest as Record<string, unknown>);
  return { id, exists: true, data: () => data as Record<string, any> };
}

function missingDocSnap(id: string): SeamDocSnap {
  return { id, exists: false, data: () => undefined };
}

function toQuerySnap(docs: SupaDoc[]): SeamQuerySnap {
  const snaps = docs.map(toDocSnap);
  return { docs: snaps, empty: snaps.length === 0, size: snaps.length };
}

/* -------------------------------------------------------------- read helpers
 * Every helper returns null when the caller must use Firestore instead:
 * flag OFF, adapter absent, or adapter error (errors are logged, never
 * thrown into the request path).
 */

export async function getDocViaSeam(
  collectionPath: string,
  id: string,
): Promise<SeamDocSnap | null> {
  const adapter = await getTasksSupaAdapter();
  if (!adapter) return null;
  try {
    const doc = await adapter.getDoc(collectionPath, id);
    return doc ? toDocSnap(doc) : missingDocSnap(id);
  } catch (e) {
    console.warn(`[seam-tasks-lists] getDoc ${collectionPath}/${id} failed, falling back to Firestore:`, e);
    return null;
  }
}

/**
 * GAP-T2-02 stated bound: the maximum rows one seam list leg may return
 * when the caller supplies no explicit limit. Sized to the largest
 * legitimate leg (a single user's, or a <=10-member chunk's, task set);
 * see the header for the evidence and the bound-before-union semantics.
 */
export const TASKS_LISTS_LEG_BOUND = 5000;

/** Apply the GAP-T2-02 bound: an explicit caller limit always wins. */
export function withLegBound(options?: SupaListOptions): SupaListOptions {
  if (options && typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    return options;
  }
  return { ...options, limit: TASKS_LISTS_LEG_BOUND };
}

export async function listDocsViaSeam(
  collectionPath: string,
  options?: SupaListOptions,
): Promise<SeamQuerySnap | null> {
  const adapter = await getTasksSupaAdapter();
  if (!adapter) return null;
  try {
    const docs = await adapter.listDocs(collectionPath, withLegBound(options));
    return toQuerySnap(docs);
  } catch (e) {
    console.warn(`[seam-tasks-lists] listDocs ${collectionPath} failed, falling back to Firestore:`, e);
    return null;
  }
}

export async function getTaskDocViaSeam(taskId: string): Promise<SeamDocSnap | null> {
  return getDocViaSeam('tasks', taskId);
}

export async function listTasksViaSeam(
  where: SupaWhereClause[],
  options?: Omit<SupaListOptions, 'where'>,
): Promise<SeamQuerySnap | null> {
  return listDocsViaSeam('tasks', { ...options, where });
}

export async function getUserDocViaSeam(uid: string): Promise<SeamDocSnap | null> {
  return getDocViaSeam('users', uid);
}

/** Subcollection read, e.g. listActivityViaSeam(taskId) for tasks/{id}/activity. */
export async function listActivityViaSeam(taskId: string): Promise<SeamQuerySnap | null> {
  return listDocsViaSeam(`tasks/${taskId}/activity`, {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 100,
  });
}

/* ------------------------------------------------------------- team helpers */

/**
 * The chapter filter the team route's Firestore path applies, reproduced
 * for seam queries. The route calls applyChapterScope WITHOUT a uid, so
 * the legacy branch runs: DEFAULT_ROLE_SCOPES (then the resolveUserScope
 * national fallback) decides 'global' vs 'chapter'; global adds no filter,
 * chapter pins chapterId to the caller's chapter or the
 * RESTRICTED_NO_CHAPTER sentinel. Returns the clause to AND into every
 * seam query, or null for the global (unfiltered) case.
 */
export function teamChapterWhereClause(user: {
  role: string;
  chapterId?: string;
}): SupaWhereClause | null {
  const legacy: 'global' | 'chapter' =
    DEFAULT_ROLE_SCOPES[user.role] ??
    (resolveUserScope(user.role) === 'national' ? 'global' : 'chapter');
  if (legacy === 'global') return null;
  if (user.chapterId) return ['chapterId', '==', user.chapterId];
  return ['chapterId', '==', RESTRICTED_NO_CHAPTER];
}

/* ------------------------------------------------------- approval-rate seam */

/**
 * Last-10 approval rate over Supa reads, using the SAME pure helpers the
 * Firestore path uses (src/lib/server/task-approval-rate.ts). Returns null
 * for Firestore fallback. The three single-field legs, the submitter
 * resolution, and the decided/approved status vocabularies are identical
 * to getLast10ApprovalRate; only the read source differs. Like the
 * Firestore helper, one failing leg does not sink the others — but if a
 * leg fails we cannot know the rate is complete, so a leg failure returns
 * null and the route falls back to the Firestore computation.
 */
export async function getApprovalRateViaSeam(
  uid: string,
): Promise<{ approved: number; decided: number; rate: number | null; hasHistory: boolean } | null> {
  const adapter = await getTasksSupaAdapter();
  if (!adapter) return null;
  try {
    const { computeApprovalRate, resolveTaskSubmitterUid } = await import(
      '@/lib/server/task-approval-rate'
    );
    const legs: SupaWhereClause[] = [
      ['assigneeId', '==', uid],
      ['assigneeIds', 'array-contains', uid],
      ['submittedBy', '==', uid],
    ];
    const byId = new Map<string, Record<string, any>>();
    for (const clause of legs) {
      // GAP-T2-02: each leg is a single-user clause; the stated per-leg
      // bound applies (see header). The full per-user set is the
      // computation's input, so the bound is sized never to truncate a
      // legitimate leg.
      const docs = await adapter.listDocs('tasks', { where: [clause], limit: TASKS_LISTS_LEG_BOUND });
      for (const doc of docs) {
        if (!byId.has(doc.id)) {
          const { id: _id, ...data } = doc;
          byId.set(doc.id, normalizeDocData(data as Record<string, unknown>));
        }
      }
    }
    const mine: Array<Record<string, any>> = [];
    for (const data of byId.values()) {
      if (resolveTaskSubmitterUid(data) === uid) mine.push(data);
    }
    return computeApprovalRate(mine);
  } catch (e) {
    console.warn('[seam-tasks-lists] approval-rate read failed, falling back to Firestore:', e);
    return null;
  }
}

/* ------------------------------------------------------------- write mirror */

/**
 * Mirror a Firestore write into Supabase. Fire-and-forget safe: flag OFF,
 * adapter absent, or mirror error all resolve quietly (logged) and never
 * fail the caller's request. Dates are serialized to ISO strings because
 * jsonb has no Timestamp type; FieldValue sentinels must be resolved by
 * the caller before mirroring.
 */
export async function mirrorSetViaSeam(
  collectionPath: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const adapter = await getTasksSupaAdapter();
  if (!adapter) return;
  try {
    await adapter.setDoc(collectionPath, id, serializeForMirror(data));
  } catch (e) {
    console.warn(`[seam-tasks-lists] mirror setDoc ${collectionPath}/${id} failed (Firestore write already applied):`, e);
  }
}

/** Local SUPA_PRIMARY fallback, mirroring flags.ts: BOTH env lists must name the surface ('*' counts). */
function localIsSupaPrimary(surface: string): boolean {
  if (!localUseSupa(surface)) return false;
  const raw = process.env.SUPA_PRIMARY;
  if (!raw) return false;
  const tokens = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return tokens.includes('*') || tokens.includes(surface.trim().toLowerCase());
}

/**
 * True when the 'tasks' surface is write-primary AND an adapter is
 * available: SUPA_SURFACES and SUPA_PRIMARY both name 'tasks' (flag law
 * in src/lib/supa/flags.ts). False in every other state, in which case
 * all write behavior in this seam is the pre-cutover dual-write.
 */
export async function tasksListsPrimaryActive(): Promise<boolean> {
  const adapter = await getTasksSupaAdapter();
  if (!adapter) return false;
  const mod = await loadSupaModule();
  try {
    if (mod && typeof mod.isSupaPrimary === 'function') {
      return mod.isSupaPrimary(TASKS_SUPA_SURFACE);
    }
  } catch {
    /* fall through to the local check */
  }
  return localIsSupaPrimary(TASKS_SUPA_SURFACE);
}

/**
 * Write-primary commit for a single doc (cutover primacy): writes the
 * adapter FIRST and THROWS on failure, so the caller fails the request
 * instead of reporting success while the primary store is stale. The
 * caller then performs its Firestore write as the post-commit mirror
 * (best-effort). Returns false when primacy is not active, meaning the
 * caller runs its normal Firestore-first flow and mirrorSetViaSeam.
 */
export async function writeDocPrimaryFirst(
  collectionPath: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!(await tasksListsPrimaryActive())) return false;
  const adapter = await getTasksSupaAdapter();
  if (!adapter) return false;
  await adapter.setDoc(collectionPath, id, serializeForMirror(data));
  return true;
}

function serializeForMirror(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      try {
        out[key] = (value as { toDate: () => Date }).toDate().toISOString();
      } catch {
        out[key] = null;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
