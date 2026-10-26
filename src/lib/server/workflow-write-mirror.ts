/**
 * workflow-write-mirror.ts — mirror-on-write for workflow-owned
 * Firestore writes (workflows cluster):
 *   POST  /api/workflows                 step tasks + workflow_members (create)
 *   PATCH /api/workflows                 step task (update)
 *   POST  /api/workflows/[id]/duplicate  cloned step tasks + members (create)
 *   deleteWorkflowCascade                step tasks + members (delete)
 *
 * WHY THIS EXISTS (root cause of the 2026-10-26 "mission with no
 * steps" incident; full investigation in
 * ~/workspace/known_issues/workflow_invisible_root_cause_2026-10-26.md):
 * the workflow READ seams (workflow-detail-supa, mission-reads-supa,
 * workflow-members-supa) read the Supabase mirror whenever the
 * 'workflows' surface is ON, and their pinned contract treats an
 * empty result as authoritative. Firestore remains the primary
 * writer for task/member docs (the 'tasks' surface was never
 * flipped), so a workflow-owned write that lands only in Firestore
 * is invisible on every mirror-reading surface: mission detail
 * ("No steps found"), the public mission page (404), and the
 * mission PDF (zero steps). The fix is at the write: every
 * workflow-owned write mirrors under the SAME flag the readers
 * check — 'workflows'.
 *
 * The tasks-route mirror (mirrorTaskDocById in
 * src/lib/supa/seam-tasks-route.ts) is deliberately NOT reused: it
 * gates on the 'tasks' surface, which is OFF in the live flip list,
 * so wiring it here would silently never mirror — exactly the
 * failure this module exists to end. Sanitization IS reused
 * (sanitizeForMirror from that module), so rows written here are
 * shape-identical to tasks-route mirrors.
 *
 * Contract (identical to the tasks-route mirror):
 * - Never throws. A mirror failure logs and the Firestore write
 *   stands; the request never fails because the mirror did.
 * - When the 'workflows' surface is OFF, the client is
 *   unconfigured, or the adapter is unavailable, every helper is a
 *   no-op and the fetch callback is NEVER invoked, so flag-OFF
 *   requests pay zero extra Firestore reads.
 *
 * LIFETIME: this mirror is part of the migration architecture, not
 * a patch. It retires when the workflow write paths themselves move
 * to the Supabase adapter (tasks/workflows primacy flip in the
 * cutover program), at which point there is no second store to keep
 * in step — the same condition under which the tasks-route mirror
 * retires.
 */

import { sanitizeForMirror } from '@/lib/supa/seam-tasks-route';

export type SupaDoc = { id: string } & Record<string, unknown>;

/** Locally declared mirror of the adapter contract (src/lib/supa). */
export interface SupaAdapterLike {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(collectionPath: string, options?: unknown): Promise<SupaDoc[]>;
  countDocs(collectionPath: string, where?: unknown[]): Promise<number>;
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
export const WORKFLOW_MEMBERS_COLLECTION = 'workflow_members';

/* --------------------------------------------------------- adapter loading */

export type SupaLoader = () => Promise<SupaModuleLike | null>;

let loaderOverride: SupaLoader | null = null;
let cachedModule: Promise<SupaModuleLike | null> | null = null;

const defaultLoader: SupaLoader = async () => {
  try {
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
export function __setWorkflowWriteMirrorLoaderForTests(loader: SupaLoader | null): void {
  loaderOverride = loader;
  cachedModule = null;
}

/**
 * The adapter when the 'workflows' surface is ON and a client is
 * configured; null otherwise (module absent / flag OFF / no client /
 * factory throws). The readers' gate, verbatim:
 * `useSupa('workflows') && getSupaClient()` -> `getSupaAdapter()`.
 */
export async function getWorkflowsWriteAdapter(): Promise<SupaAdapterLike | null> {
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

/* ------------------------------------------------------------ mirror writes */

/**
 * Mirror one doc by re-reading its final Firestore state through
 * `fetchData` (invoked ONLY when mirroring is actually active, so
 * flag-OFF requests pay zero extra reads). Never throws.
 */
async function mirrorDocById(
  collection: string,
  id: string,
  fetchData: () => Promise<Record<string, any> | undefined>,
): Promise<void> {
  try {
    const adapter = await getWorkflowsWriteAdapter();
    if (!adapter) return;
    const data = await fetchData();
    if (!data) return;
    await adapter.setDoc(collection, id, sanitizeForMirror(data));
  } catch (err) {
    console.warn(`[workflow-write-mirror] Mirror upsert failed for ${collection}/${id} (non-blocking):`, err);
  }
}

/** Delete one doc from the mirror. Never throws. */
async function mirrorDeleteById(collection: string, id: string): Promise<void> {
  try {
    const adapter = await getWorkflowsWriteAdapter();
    if (!adapter) return;
    await adapter.deleteDoc(collection, id);
  } catch (err) {
    console.warn(`[workflow-write-mirror] Mirror delete failed for ${collection}/${id} (non-blocking):`, err);
  }
}

/** Mirror a workflow step task doc (create or update). */
export async function mirrorWorkflowTaskDocById(
  id: string,
  fetchData: () => Promise<Record<string, any> | undefined>,
): Promise<void> {
  await mirrorDocById(TASKS_COLLECTION, id, fetchData);
}

/** Mirror a workflow_members doc (`${workflowId}_${uid}`). */
export async function mirrorWorkflowMemberDocById(
  memberId: string,
  fetchData: () => Promise<Record<string, any> | undefined>,
): Promise<void> {
  await mirrorDocById(WORKFLOW_MEMBERS_COLLECTION, memberId, fetchData);
}

/** Mirror deletes for step task docs removed by the cascade. */
export async function mirrorWorkflowTaskDeletesByIds(ids: string[]): Promise<void> {
  const unique = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  for (const id of unique) {
    await mirrorDeleteById(TASKS_COLLECTION, id);
  }
}

/** Mirror deletes for workflow_members docs removed by the cascade. */
export async function mirrorWorkflowMemberDeletesByIds(ids: string[]): Promise<void> {
  const unique = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  for (const id of unique) {
    await mirrorDeleteById(WORKFLOW_MEMBERS_COLLECTION, id);
  }
}
