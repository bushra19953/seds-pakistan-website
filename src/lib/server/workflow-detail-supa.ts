/**
 * workflow-detail-supa.ts — the ONE seam module for the workflows
 * cluster group 5 (wf-5): the read inputs of the workflow DETAIL
 * route, GET /api/workflows?workflowId= in the PINNED file
 * src/app/api/workflows/route.ts (base 4d5a1e16, detail branch
 * lines 449-630).
 *
 * The pinned route stays byte-identical on this branch; the route
 * wiring that calls this seam is merge-plan step 17's act. This
 * module is complete and correct standalone: step 17 only has to
 * ask the seam for the read inputs and, on a non-null result, skip
 * the Firestore reads. See supa-rebase-notes/wf-5.md for the full
 * read inventory (exact base line numbers) and the step-17 wiring
 * diff.
 *
 * The detail handler's reads (all inline in the pinned file):
 *   L451  tasks where workflowId == X            -> snap.docs[].{id,data()}
 *   L489  chapters doc(firstTask.chapterId)      -> { exists, data()?.name }
 *   L502  users doc(uid) per unique assignee     -> { id, exists, data() }
 *   L516  chapters doc(user.chapterId), cached   -> { exists, data()?.name }
 *   L569  roles doc(viewerUid), .catch(() => null) -> { exists, data()?.role }
 *   L577  workflow_members doc(`${workflowId}_${viewerUid}`)
 *                                                -> { exists } (masking gate)
 *
 * Contract, aligned exactly to the landed adapter
 * (feat/supa-adapter @ 85e657f + f7defc3, src/lib/supa/) and the
 * wf-4 seam precedent (workflow-members-supa.ts):
 *
 *   import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
 *   if (useSupa('workflows') && getSupaClient()) {
 *     const adapter = getSupaAdapter(); // .getDoc/.listDocs/...
 *   }
 *
 * - Surface string is exactly 'workflows'. Flag default OFF;
 *   getSupaClient() returns null when SUPABASE_URL /
 *   SUPABASE_SERVICE_ROLE_KEY are unset (never throws).
 * - Any gate failure, unconfigured client, or adapter error makes
 *   every helper here return null, and the caller falls back to
 *   EXACTLY today's Firestore path.
 * - An EMPTY store is NOT a gate failure: list helpers return an
 *   empty snapshot ({ docs: [], empty: true }) and doc helpers
 *   return { exists: false, data: () => undefined }, so step 17 can
 *   distinguish "workflow not in Supa" (404-equivalent data state)
 *   from "Supa unavailable" (null -> Firestore fallback).
 * - Data passes through VERBATIM. The adapter ISO-normalizes
 *   timestamps (kit) / rehydrates them (adapter fix-wave ruling);
 *   the pinned handler's serializeTs already accepts a Timestamp
 *   (toDate()), a {seconds} shape, or an ISO string, so no revival
 *   is needed or performed here. The wf-6 contract suite proves the
 *   route's output is byte-identical for Firestore-shaped and
 *   jsonb-shaped (ISO string) inputs.
 * - Only READS live here. Nothing in the detail chain writes.
 *
 * The adapter is NOT present in this base tree and must not be
 * merged or cherry-picked into it, so it is reached through a lazy
 * dynamic import via a variable specifier typed against the locally
 * declared SupaAdapterLike mirror below (the wf-4 / tasks-2 seam
 * precedent). MERGE-TIME: once src/lib/supa/index.ts lands it
 * exports exactly the three functions used here with the shapes
 * declared here; no seam code change is needed.
 */

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
  getSupaClient?: () => unknown;
  useSupa?: (surface: string) => boolean;
}

export const WORKFLOWS_SUPA_SURFACE = 'workflows';
export const TASKS_COLLECTION = 'tasks';
export const USERS_COLLECTION = 'users';
export const CHAPTERS_COLLECTION = 'chapters';
export const ROLES_COLLECTION = 'roles';
export const WORKFLOW_MEMBERS_COLLECTION = 'workflow_members';

/* ------------------------------------------------ Firestore-shaped results */

/**
 * Mirror of an Admin SDK DocumentSnapshot as the pinned handler
 * consumes it: `.id`, `.exists`, `.data()` (undefined when missing).
 */
export interface SupaDocSnapshotLike {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

/** Mirror of one document inside a QuerySnapshot: `.id`, `.data()`. */
export interface SupaQueryDocLike {
  id: string;
  data: () => Record<string, unknown>;
}

/** Mirror of an Admin SDK QuerySnapshot: `.docs`, `.empty`. */
export interface SupaQuerySnapshotLike {
  docs: SupaQueryDocLike[];
  empty: boolean;
}

/** Adapter rows are `{ id, ...data }`; data() must not re-expose the id key. */
function toDocSnapshot(row: SupaDoc | null, id: string): SupaDocSnapshotLike {
  if (!row) {
    return { id, exists: false, data: () => undefined };
  }
  const { id: _rowId, ...data } = row;
  return { id, exists: true, data: () => data };
}

function toQuerySnapshot(rows: SupaDoc[]): SupaQuerySnapshotLike {
  return {
    docs: rows.map((row) => {
      const { id, ...data } = row;
      return { id: String(id), data: () => data };
    }),
    empty: rows.length === 0,
  };
}

/* --------------------------------------------------------- adapter loading */

type SupaLoader = () => Promise<SupaModuleLike | null>;

let loaderOverride: SupaLoader | null = null;
let cachedModule: Promise<SupaModuleLike | null> | null = null;

const defaultLoader: SupaLoader = async () => {
  try {
    // Variable specifier on purpose: the module is absent in this base
    // tree, so a static/literal import would fail type-check and build.
    const specifier: string = '@/lib/supa';
    const mod = (await import(specifier)) as SupaModuleLike;
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
export function __setWorkflowDetailSupaLoaderForTests(loader: SupaLoader | null): void {
  loaderOverride = loader;
  cachedModule = null;
}

/**
 * The adapter when the 'workflows' surface is ON and a client is
 * configured; null otherwise (module absent / flag OFF / no client /
 * factory throws). This is the coordinator's gate pattern verbatim:
 * `useSupa('workflows') && getSupaClient()` -> `getSupaAdapter()`.
 */
export async function getWorkflowsSupaAdapter(): Promise<SupaAdapterLike | null> {
  const mod = await loadSupaModule();
  if (!mod) return null;
  try {
    if (typeof mod.useSupa !== 'function' || typeof mod.getSupaClient !== 'function') return null;
    if (!mod.useSupa(WORKFLOWS_SUPA_SURFACE)) return null;
    if (!mod.getSupaClient()) return null;
    if (typeof mod.getSupaAdapter !== 'function') return null;
    return mod.getSupaAdapter();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- detail reads */

/**
 * Pinned route L451: `tasks where workflowId == X`, as a
 * QuerySnapshot-shaped { docs: [{ id, data() }], empty }.
 * Unordered, exactly like the Firestore query (the handler sorts by
 * sequenceIndex itself). Null = Supa unavailable, use Firestore.
 * An empty workflow returns { docs: [], empty: true }, NOT null.
 */
export async function listWorkflowTasksViaSupa(
  workflowId: string,
): Promise<SupaQuerySnapshotLike | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;
  try {
    const rows = await adapter.listDocs(TASKS_COLLECTION, {
      where: [['workflowId', '==', workflowId]],
    });
    if (!Array.isArray(rows)) return null;
    return toQuerySnapshot(rows);
  } catch {
    // SupaAdapterError / SupaUnavailableError / anything: Firestore fallback.
    return null;
  }
}

/**
 * One doc as a DocumentSnapshot-shaped { id, exists, data() }.
 * Shared core of the users/chapters/roles/workflow_members reads.
 * Adapter getDoc -> null (doc absent) is a REAL result:
 * { exists: false, data: () => undefined }. Only gate failure or an
 * adapter throw returns null (Firestore fallback).
 */
async function getDocSnapshotViaSupa(
  adapter: SupaAdapterLike,
  collection: string,
  id: string,
): Promise<SupaDocSnapshotLike | null> {
  try {
    const row = await adapter.getDoc(collection, id);
    if (row !== null && (typeof row !== 'object' || Array.isArray(row))) return null;
    return toDocSnapshot(row, id);
  } catch {
    return null;
  }
}

/** Pinned route L502: `users doc(uid)` for each unique assignee. */
export async function getWorkflowUserViaSupa(uid: string): Promise<SupaDocSnapshotLike | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;
  return getDocSnapshotViaSupa(adapter, USERS_COLLECTION, uid);
}

/** Pinned route L489 + L516: `chapters doc(chapterId)`. */
export async function getWorkflowChapterViaSupa(
  chapterId: string,
): Promise<SupaDocSnapshotLike | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;
  return getDocSnapshotViaSupa(adapter, CHAPTERS_COLLECTION, chapterId);
}

/**
 * Pinned route L569: `roles doc(viewerUid)`. Note the handler wraps
 * this read in .catch(() => null) and treats a null/missing snapshot
 * as "no live role" (falls back to the token claim) — a seam null
 * (fallback) and a snapshot with exists:false both preserve that.
 */
export async function getWorkflowRoleViaSupa(uid: string): Promise<SupaDocSnapshotLike | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;
  return getDocSnapshotViaSupa(adapter, ROLES_COLLECTION, uid);
}

/**
 * Pinned route L576-578: `workflow_members doc(`${workflowId}_${uid}`)`.
 * Only `.exists` is consumed — it is the membership gate that unmasks
 * contact fields for a viewer who is neither admin nor participant.
 * The full snapshot shape is returned so the gate stays faithful if
 * the handler ever reads fields.
 */
export async function getWorkflowMemberViaSupa(
  workflowId: string,
  uid: string,
): Promise<SupaDocSnapshotLike | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;
  return getDocSnapshotViaSupa(adapter, WORKFLOW_MEMBERS_COLLECTION, `${workflowId}_${uid}`);
}

/* ------------------------------------------------- aggregate (step-17 form) */

/** Assignee ids of one task doc, replicating the pinned handler's
 *  taskAssigneeIds (L476-479): assigneeIds[] wins when non-empty,
 *  else the singular assigneeId. Pure. */
export function detailTaskAssigneeIds(task: Record<string, unknown>): string[] {
  const ids = task.assigneeIds;
  if (Array.isArray(ids) && ids.length) return ids.map(String).filter(Boolean);
  return task.assigneeId ? [String(task.assigneeId)] : [];
}

/** Everything the detail branch reads, in the shapes it consumes. */
export interface WorkflowDetailReads {
  /** L451: tasks snapshot ({ docs: [{id, data()}], empty }). */
  tasksSnap: SupaQuerySnapshotLike;
  /** L489: chapters doc of the first task carrying a chapterId
   *  (null when no task carries one — the handler skips the read). */
  workflowChapterSnap: SupaDocSnapshotLike | null;
  /** L502: users snapshots, parallel to uniqueAssigneeIds order. */
  userSnaps: SupaDocSnapshotLike[];
  /** The unique assignee ids the userSnaps are parallel to. */
  uniqueAssigneeIds: string[];
  /** L516: chapters snapshots keyed by chapterId, only for users
   *  whose doc lacks chapterName and carries a chapterId (the
   *  handler's chapterCache, pre-filled). */
  userChapterSnaps: Record<string, SupaDocSnapshotLike>;
  /** L569: roles doc of the viewer. */
  roleSnap: SupaDocSnapshotLike;
  /** L577: workflow_members doc `${workflowId}_${viewerUid}`. */
  memberSnap: SupaDocSnapshotLike;
}

/**
 * Fetch the detail branch's ENTIRE read set through the adapter, in
 * the handler's own derivation order (tasks -> first chapter ->
 * users -> per-user chapters -> viewer role -> membership doc).
 * Returns null if ANY read is unavailable/throws, so step 17 falls
 * back to the whole Firestore chain rather than mixing stores
 * mid-response. Empty/missing docs surface as exists:false /
 * empty docs, never as null.
 */
export async function fetchWorkflowDetailReadsViaSupa(
  workflowId: string,
  viewerUid: string,
): Promise<WorkflowDetailReads | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;

  const tasksSnap = await listWorkflowTasksViaSupa(workflowId);
  if (!tasksSnap) return null;
  const taskData = tasksSnap.docs.map((d) => d.data());

  // L486-495: chapter of the first task carrying a chapterId.
  let workflowChapterSnap: SupaDocSnapshotLike | null = null;
  const firstChapterId = taskData.find((t) => !!t.chapterId)?.chapterId;
  if (firstChapterId) {
    workflowChapterSnap = await getDocSnapshotViaSupa(
      adapter,
      CHAPTERS_COLLECTION,
      String(firstChapterId),
    );
    if (!workflowChapterSnap) return null;
  }

  // L480 + L500-503: unique assignees (both assignee forms), parallel gets.
  const uniqueAssigneeIds = Array.from(new Set(taskData.flatMap(detailTaskAssigneeIds)));
  const userSnaps: SupaDocSnapshotLike[] = [];
  for (const uid of uniqueAssigneeIds) {
    const snap = await getDocSnapshotViaSupa(adapter, USERS_COLLECTION, uid);
    if (!snap) return null;
    userSnaps.push(snap);
  }

  // L509-524: per-user chapter lookups, only where the user doc has
  // a chapterId and no chapterName of its own (handler's cache keys).
  const userChapterSnaps: Record<string, SupaDocSnapshotLike> = {};
  for (const snap of userSnaps) {
    if (!snap.exists) continue;
    const userData = snap.data() as Record<string, unknown>;
    const chapterId = userData?.chapterId;
    if (userData?.chapterName || !chapterId) continue;
    const key = String(chapterId);
    if (userChapterSnaps[key]) continue;
    const chapSnap = await getDocSnapshotViaSupa(adapter, CHAPTERS_COLLECTION, key);
    if (!chapSnap) return null;
    userChapterSnaps[key] = chapSnap;
  }

  // L569: viewer's live role doc.
  const roleSnap = await getDocSnapshotViaSupa(adapter, ROLES_COLLECTION, viewerUid);
  if (!roleSnap) return null;

  // L576-578: membership gate doc.
  const memberSnap = await getDocSnapshotViaSupa(
    adapter,
    WORKFLOW_MEMBERS_COLLECTION,
    `${workflowId}_${viewerUid}`,
  );
  if (!memberSnap) return null;

  return {
    tasksSnap,
    workflowChapterSnap,
    userSnaps,
    uniqueAssigneeIds,
    userChapterSnaps,
    roleSnap,
    memberSnap,
  };
}
