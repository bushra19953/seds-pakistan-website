/**
 * seam-admin-tasks.ts — the ONE Supabase seam for the admin tasks page
 * data paths (tasks cluster, group 3). SERVER-SIDE ONLY.
 *
 * Consumers:
 * - src/app/api/tasks/by-user/route.ts  (NEW surface: getUserTasks /
 *   getTasksCreatedBy query shapes from src/lib/task-management.ts)
 * - src/app/api/tasks/all/route.ts      (NEW surface: getAllTasks)
 * - src/app/api/tasks/batch/route.ts    (bulk DELETE mirror)
 *
 * Client files (src/app/admin/tasks/page.tsx, src/lib/task-management.ts)
 * contain ZERO adapter references: they reach this seam only through the
 * endpoints above, exactly like the page already reaches /api/tasks and
 * /api/users/picker.
 *
 * Behavior contract:
 * - Flag OFF (default), adapter absent/unconfigured, or adapter load
 *   failure -> resolveAdminTasksSupaAdapter() returns null and every
 *   consumer falls back to EXACTLY today's Firestore behavior and shapes.
 *   The by-user/all endpoints answer 404 while the flag is OFF.
 * - Flag ON + adapter present: reads go through the list/get helpers
 *   below; the batch route's writes stay on Firestore and are mirrored
 *   via mirrorBatchTaskDeletes(). Mirror functions NEVER throw.
 *
 * GAP-T3-01 — CLOSED (cutover program, feat/supa-cut-tasks; ratified by
 * Zubair's Option A order). listAllTaskDocs() previously forwarded an
 * UNBOUNDED adapter read when the caller passed no limit, silently
 * differing from the /api/tasks/all endpoint's stated bound. Decision:
 * a no-limit call now FAILS LOUDLY (throws TASKS_ALL_LIMIT_REQUIRED)
 * instead of reading unbounded or silently truncating. The endpoint
 * always supplies an explicit limit (default 500, cap 2000 — see the
 * route header), so no legitimate caller is affected; the helper's
 * only client-side consumer (task-management getAllTasks) has no
 * executing caller today (dead import in the admin page, verified in
 * the tasks-cluster DESIGN_VERDICT).
 *
 * GAP-T2-02 (admin-seam legs): the per-user / per-workflow list helpers
 * below carry the same stated per-leg bound as seam-tasks-lists
 * (TASKS_ADMIN_LEG_BOUND), applied per leg before any in-memory union.
 * Each leg filters to one user's or one workflow's task set by
 * construction; the bound is sized far above any legitimate leg.
 *
 * Write primacy (cutover): when isSupaPrimary('tasks') is true,
 * commitBatchTaskDeletesPrimary() runs the adapter deletes + counter
 * adjustments FIRST and throws on a task-delete failure, so the batch
 * route fails the request instead of reporting a delete the primary
 * store did not take; the route's Firestore batch then runs as the
 * post-commit mirror, best-effort. SUPA_PRIMARY unset: behavior is
 * exactly the pre-cutover dual-write above.
 */
 * The real adapter (src/lib/supa/index.ts, built in parallel) is NOT in
 * this tree. It is reached through a lazy dynamic import with a variable
 * specifier so tsc stays clean on this base, typed against the locally
 * declared AdminTasksSupaAdapter interface matching the adapter contract
 * (getDoc/listDocs/countDocs/setDoc/updateDoc/deleteDoc over
 * fs_<collection> jsonb tables, Firestore-shaped { id, ...data } results).
 * See supa-rebase-notes/tasks-3.md.
 */

/** One where clause: [field, operator, value], Firestore-style operators. */
export type SupaWhereClause = [field: string, op: string, value: any];

export interface SupaListOptions {
  where?: SupaWhereClause[];
  orderBy?: [field: string, direction: 'asc' | 'desc'] | string;
  limit?: number;
  startAfter?: any;
}

export interface AdminTasksSupaAdapter {
  getDoc(collection: string, id: string): Promise<Record<string, any> | null>;
  listDocs(collection: string, options?: SupaListOptions): Promise<Array<Record<string, any>>>;
  countDocs(collection: string, where?: SupaWhereClause[]): Promise<number>;
  setDoc(collection: string, id: string, data: Record<string, any>, options?: { merge?: boolean }): Promise<any>;
  updateDoc(collection: string, id: string, data: Record<string, any>): Promise<any>;
  deleteDoc(collection: string, id: string): Promise<void>;
}

export const ADMIN_TASKS_SUPA_SURFACE = 'tasks';
export const TASKS_COLLECTION = 'tasks';
export const USERS_COLLECTION = 'users';

/**
 * useSupa('tasks') equivalent for this tree: env-driven via the
 * SUPA_SURFACES comma-separated list ('*' = all surfaces), default OFF.
 * At merge time this can be swapped for the adapter's own useSupa helper.
 */
export function isAdminTasksSupaFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SUPA_SURFACES || '';
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.includes('*') || parts.includes(ADMIN_TASKS_SUPA_SURFACE);
}

// ---------------------------------------------------------------------------
// Adapter resolution (lazy, cached, test-injectable)
// ---------------------------------------------------------------------------

let injectedAdapter: AdminTasksSupaAdapter | null | undefined;
let adapterPromise: Promise<AdminTasksSupaAdapter | null> | null = null;

/** Test-only: inject a mocked adapter (or null to simulate absence). */
export function __setAdminTasksSupaAdapterForTests(adapter: AdminTasksSupaAdapter | null): void {
  injectedAdapter = adapter;
  adapterPromise = null;
}

/** Test-only: clear injection and the cached adapter promise. */
export function __resetAdminTasksSupaAdapterForTests(): void {
  injectedAdapter = undefined;
  adapterPromise = null;
}

async function loadAdapterModule(): Promise<AdminTasksSupaAdapter | null> {
  // Variable specifier on purpose: the adapter module does not exist in
  // this tree, so a static/literal import would fail tsc and the build.
  // At merge time this resolves to '@/lib/supa' (its index re-exports
  // getSupaAdapter / useSupa from the adapter workstream).
  const specifier: string = process.env.SUPA_ADAPTER_SPECIFIER || '@/lib/supa';
  try {
    const mod: any = await import(/* webpackIgnore: true */ specifier);
    const candidate: any =
      (typeof mod?.getSupaAdapter === 'function' ? mod.getSupaAdapter() : null) ??
      mod?.default ??
      mod?.adapter ??
      mod;
    if (
      candidate &&
      typeof candidate.listDocs === 'function' &&
      typeof candidate.getDoc === 'function' &&
      typeof candidate.deleteDoc === 'function'
    ) {
      return candidate as AdminTasksSupaAdapter;
    }
    console.warn('[supa-seam:admin-tasks] Adapter module loaded but does not match the contract; staying on Firestore');
    return null;
  } catch (err) {
    console.warn('[supa-seam:admin-tasks] Adapter unavailable; staying on Firestore', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolve the adapter for the 'tasks' surface, or null when the surface
 * flag is OFF, the adapter is absent/unconfigured, or loading failed.
 * Returning null always means: use the Firestore path, unchanged.
 */
export async function resolveAdminTasksSupaAdapter(): Promise<AdminTasksSupaAdapter | null> {
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (!isAdminTasksSupaFlagOn()) return null;
  if (!adapterPromise) adapterPromise = loadAdapterModule();
  return adapterPromise;
}

// ---------------------------------------------------------------------------
// Timestamp normalization
//
// Task docs carry Firestore Timestamps on the Firestore path. From jsonb
// they come back as ISO strings (or {seconds, nanoseconds} plain
// objects). Consumers call .toDate() (see the census in
// supa-rebase-notes/tasks-3.md), so seam-served docs get their known
// timestamp fields wrapped in a Firestore-Timestamp-shaped value.
// ---------------------------------------------------------------------------

export interface SeamTimestamp {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
  toISOString(): string;
  toJSON(): string;
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
    toJSON: () => new Date(ms).toISOString(),
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Returns a SeamTimestamp for ISO strings / {seconds,...} shapes, else null. */
export function toSeamTimestamp(value: any): SeamTimestamp | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!ISO_DATE_RE.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : makeSeamTimestamp(ms);
  }
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function' || typeof value.toDate === 'function') {
      return value as SeamTimestamp;
    }
    if (typeof value.seconds === 'number') {
      return makeSeamTimestamp(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
    }
    if (typeof value._seconds === 'number') {
      return makeSeamTimestamp(value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6));
    }
  }
  return null;
}

/** Top-level task-doc fields that hold Firestore Timestamps. */
export const TASK_TIMESTAMP_FIELDS: readonly string[] = [
  'createdAt',
  'updatedAt',
  'deadline',
  'individualDeadline',
  'completedAt',
  'submittedAt',
  'approvedAt',
  'rejectedAt',
  'acceptedAt',
  'startedAt',
  'availabilityConfirmedAt',
];

/** Normalize one seam-served task doc: known timestamp fields become SeamTimestamps. */
export function normalizeTaskDoc(raw: Record<string, any>): Record<string, any> {
  const { id, ...data } = raw || {};
  const out: Record<string, any> = { id: String(id ?? ''), ...data };
  for (const field of TASK_TIMESTAMP_FIELDS) {
    if (out[field] != null) {
      const ts = toSeamTimestamp(out[field]);
      if (ts) out[field] = ts;
    }
  }
  if (out.availabilityConfirmation && typeof out.availabilityConfirmation === 'object') {
    const conf = { ...out.availabilityConfirmation };
    if (conf.confirmedAt != null) {
      const ts = toSeamTimestamp(conf.confirmedAt);
      if (ts) conf.confirmedAt = ts;
    }
    out.availabilityConfirmation = conf;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads (all take the resolved adapter; callers fall back on null/throw)
// ---------------------------------------------------------------------------

/** GAP-T2-02 stated per-leg bound for this seam's filtered list helpers. */
export const TASKS_ADMIN_LEG_BOUND = 5000;

/**
 * getAllTasks shape: every task doc, BOUNDED. GAP-T3-01 (see header):
 * the limit is REQUIRED — a no-limit call throws instead of issuing an
 * unbounded read or silently truncating. The /api/tasks/all endpoint
 * always supplies one (default 500, cap 2000).
 */
export async function listAllTaskDocs(
  adapter: AdminTasksSupaAdapter,
  limit?: number,
): Promise<Array<Record<string, any>>> {
  if (limit === undefined) {
    throw new Error(
      'TASKS_ALL_LIMIT_REQUIRED: listAllTaskDocs requires an explicit limit (GAP-T3-01: unbounded reads are forbidden; the /api/tasks/all endpoint supplies default 500, cap 2000)',
    );
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`listAllTaskDocs: limit must be a positive number, got ${limit}`);
  }
  const docs = await adapter.listDocs(TASKS_COLLECTION, { limit: Math.floor(limit) });
  return docs.map(normalizeTaskDoc);
}

/**
 * getUserTasks shape: union of assigneeId == uid and
 * assigneeIds array-contains uid, deduped by id (s1 first), exactly like
 * the Firestore helper.
 */
export async function listTasksByAssigneeDocs(
  adapter: AdminTasksSupaAdapter,
  userId: string,
): Promise<Array<Record<string, any>>> {
  const [s1, s2] = await Promise.all([
    adapter.listDocs(TASKS_COLLECTION, { where: [['assigneeId', '==', userId]], limit: TASKS_ADMIN_LEG_BOUND }),
    adapter.listDocs(TASKS_COLLECTION, { where: [['assigneeIds', 'array-contains', userId]], limit: TASKS_ADMIN_LEG_BOUND }),
  ]);
  const seen = new Set<string>();
  return [...s1, ...s2]
    .filter((d) => {
      const id = String((d as any)?.id ?? '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(normalizeTaskDoc);
}

/** getTasksCreatedBy shape: assignerId == uid. */
export async function listTasksCreatedByDocs(
  adapter: AdminTasksSupaAdapter,
  userId: string,
): Promise<Array<Record<string, any>>> {
  const docs = await adapter.listDocs(TASKS_COLLECTION, {
    where: [['assignerId', '==', userId]],
    limit: TASKS_ADMIN_LEG_BOUND,
  });
  return docs.map(normalizeTaskDoc);
}

/**
 * Admin page edit-dialog shape: workflow steps are task docs with
 * workflowId == wfId, ordered by sequenceIndex asc (the page's direct
 * Firestore query at page.tsx:581-582 in base).
 */
export async function listTasksByWorkflowDocs(
  adapter: AdminTasksSupaAdapter,
  workflowId: string,
): Promise<Array<Record<string, any>>> {
  const docs = await adapter.listDocs(TASKS_COLLECTION, {
    where: [['workflowId', '==', workflowId]],
    orderBy: ['sequenceIndex', 'asc'],
    limit: TASKS_ADMIN_LEG_BOUND,
  });
  return docs.map(normalizeTaskDoc);
}

/** getTask shape: one doc or null. */
export async function getTaskDoc(
  adapter: AdminTasksSupaAdapter,
  taskId: string,
): Promise<Record<string, any> | null> {
  const doc = await adapter.getDoc(TASKS_COLLECTION, taskId);
  return doc ? normalizeTaskDoc(doc) : null;
}

/**
 * Write-primary gate for this seam (flag law, src/lib/supa/flags.ts):
 * true iff BOTH SUPA_SURFACES and SUPA_PRIMARY name 'tasks' ('*' counts
 * in either). Env-only check; adapter availability is the caller's
 * resolveAdminTasksSupaAdapter() result.
 */
export function isAdminTasksSupaPrimary(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isAdminTasksSupaFlagOn(env)) return false;
  const parts = (env.SUPA_PRIMARY || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.includes('*') || parts.includes(ADMIN_TASKS_SUPA_SURFACE);
}

// ---------------------------------------------------------------------------
// Batch-delete mirror (NEVER throws)
// ---------------------------------------------------------------------------

/**
 * Mirror a completed Firestore batch delete into Supabase:
 * - delete each task doc;
 * - apply the same per-assignee counter decrements the Firestore batch
 *   applied as FieldValue.increment(-n), as absolute read-modify-write
 *   values (the adapter has no increment primitive; only numeric current
 *   values are adjusted, missing docs/fields are skipped).
 * Any failure is logged and swallowed: the Firestore result stands.
 */
export async function mirrorBatchTaskDeletes(
  adapter: AdminTasksSupaAdapter,
  taskIds: string[],
  assigneeDecrements: Record<string, number>,
  completedDecrements: Record<string, number>,
): Promise<void> {
  try {
    for (const id of taskIds) {
      try {
        await adapter.deleteDoc(TASKS_COLLECTION, id);
      } catch (err) {
        console.warn('[supa-seam:admin-tasks] mirror delete failed for task', id, err instanceof Error ? err.message : err);
      }
    }
    for (const [uid, count] of Object.entries(assigneeDecrements)) {
      try {
        const user = await adapter.getDoc(USERS_COLLECTION, uid);
        if (!user) continue;
        const updates: Record<string, any> = {};
        if (typeof user.tasksAssignedCount === 'number') {
          updates.tasksAssignedCount = user.tasksAssignedCount - count;
        }
        if (completedDecrements[uid] && typeof user.tasksCompletedCount === 'number') {
          updates.tasksCompletedCount = user.tasksCompletedCount - completedDecrements[uid];
        }
        if (Object.keys(updates).length > 0) {
          await adapter.updateDoc(USERS_COLLECTION, uid, updates);
        }
      } catch (err) {
        console.warn('[supa-seam:admin-tasks] mirror counter update failed for user', uid, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn('[supa-seam:admin-tasks] batch mirror failed', err instanceof Error ? err.message : err);
  }
}

/**
 * Write-primary variant of the batch delete commit (cutover primacy):
 * the adapter deletes run FIRST and a task-delete failure THROWS, so
 * the route fails the request instead of reporting a delete the
 * primary store did not take. Counter adjustments keep the mirror's
 * read-modify-write shape and stay best-effort (they target the users
 * surface, whose primacy is a separate flip). The caller runs its
 * Firestore batch afterwards as the post-commit mirror, best-effort.
 */
export async function commitBatchTaskDeletesPrimary(
  adapter: AdminTasksSupaAdapter,
  taskIds: string[],
  assigneeDecrements: Record<string, number>,
  completedDecrements: Record<string, number>,
): Promise<void> {
  for (const id of taskIds) {
    await adapter.deleteDoc(TASKS_COLLECTION, id);
  }
  for (const [uid, count] of Object.entries(assigneeDecrements)) {
    try {
      const user = await adapter.getDoc(USERS_COLLECTION, uid);
      if (!user) continue;
      const updates: Record<string, any> = {};
      if (typeof user.tasksAssignedCount === 'number') {
        updates.tasksAssignedCount = user.tasksAssignedCount - count;
      }
      if (completedDecrements[uid] && typeof user.tasksCompletedCount === 'number') {
        updates.tasksCompletedCount = user.tasksCompletedCount - completedDecrements[uid];
      }
      if (Object.keys(updates).length > 0) {
        await adapter.updateDoc(USERS_COLLECTION, uid, updates);
      }
    } catch (err) {
      console.warn('[supa-seam:admin-tasks] primary counter update failed for user', uid, err instanceof Error ? err.message : err);
    }
  }
}
