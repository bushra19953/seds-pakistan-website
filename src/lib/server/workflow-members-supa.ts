/**
 * workflow-members-supa.ts — the ONE seam module for the workflows
 * cluster group 4 (workflow_members reads):
 *   src/lib/server/workflow-cascade.ts          (collectWorkflowDeletions)
 *   src/app/api/workflows/[id]/duplicate/route.ts (member copy source)
 *
 * See supa-rebase-notes/wf-4.md for the full inventory/dispositions.
 *
 * Contract, aligned exactly to the landed adapter
 * (feat/supa-adapter @ 85e657f + f7defc3, src/lib/supa/):
 *
 *   import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
 *   if (useSupa('workflows') && getSupaClient()) {
 *     const adapter = getSupaAdapter(); // .getDoc/.listDocs/.countDocs/
 *                                        // .setDoc/.updateDoc/.deleteDoc
 *   }
 *
 * - Surface string is exactly 'workflows'. Flag default OFF
 *   (SUPA_SURFACES unset / not naming 'workflows'); getSupaClient()
 *   returns null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
 *   unset (never throws).
 * - Any gate failure, unconfigured client, or adapter error
 *   (SupaAdapterError / SupaUnavailableError / anything else) makes
 *   every helper here return null, and the caller falls back to
 *   EXACTLY today's Firestore path (byte-identical result set).
 * - Only READS live here. workflow_members writes stay on Firestore
 *   in this group (they ride shared batches with tasks — see the
 *   inventory, M1/M3/M4/M6).
 *
 * The adapter is NOT present in this base tree and must not be merged
 * or cherry-picked into it, so it is reached through a lazy dynamic
 * import via a variable specifier typed against the locally declared
 * SupaAdapterLike mirror below (the tasks-2 seam precedent). That
 * keeps tsc/jest green while the module is absent and resolves to
 * null when unavailable. MERGE-TIME: once src/lib/supa/index.ts lands
 * it exports exactly the three functions used here with the shapes
 * declared here; no seam code change is needed.
 *
 * Timestamp note: member docs carry `joinedAt` (a Firestore
 * Timestamp in Firestore, an ISO string / {_seconds,_nanoseconds}
 * shape in jsonb). Neither consumer in this group reads joinedAt —
 * cascade uses only doc ids, duplicate uses only id + userId and
 * writes a fresh serverTimestamp — so no timestamp revival is
 * needed or performed here. The pinned single-doc consumer (M2 in
 * the inventory) likewise uses only `.exists`.
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
export const WORKFLOW_MEMBERS_COLLECTION = 'workflow_members';

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
export function __setWorkflowMembersSupaLoaderForTests(loader: SupaLoader | null): void {
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

/* ------------------------------------------------------------- member reads */

/**
 * Every workflow_members doc as a Firestore-shaped `{ id, ...data }`
 * object, or null when the Supa path is not available and the caller
 * must use Firestore.
 *
 * Deliberately UNFILTERED (no `where`): both consumers originally do
 * a full-collection Firestore `.get()` and prefix-filter in memory,
 * because membership is keyed by doc id (`{workflowId}_{uid}`), not
 * by the `workflowId` field. Keeping the seam unfiltered preserves
 * the exact result set, including any malformed doc whose fields are
 * missing but whose id prefix matches. Order is unspecified in both
 * stores; both consumers treat the result as a set.
 */
export async function listWorkflowMembersViaSupa(): Promise<SupaDoc[] | null> {
  const adapter = await getWorkflowsSupaAdapter();
  if (!adapter) return null;
  try {
    const docs = await adapter.listDocs(WORKFLOW_MEMBERS_COLLECTION);
    if (!Array.isArray(docs)) return null;
    return docs;
  } catch {
    // SupaAdapterError / SupaUnavailableError / anything: Firestore fallback.
    return null;
  }
}

/**
 * The uid set for one workflow from member-shaped docs
 * (`{ id, userId? }`), replicating the duplicate route's original
 * extraction exactly: keep docs whose id starts with
 * `${workflowId}_`; uid is `String(data.userId || id-suffix)`; empty
 * uids are skipped. Pure — shared by the route and the tests.
 */
export function extractWorkflowMemberUids(
  docs: ReadonlyArray<{ id: string; userId?: unknown }>,
  workflowId: string,
): Set<string> {
  const prefix = `${workflowId}_`;
  const uids = new Set<string>();
  for (const d of docs) {
    if (!d.id.startsWith(prefix)) continue;
    const uid = String(d.userId || d.id.slice(workflowId.length + 1));
    if (!uid) continue;
    uids.add(uid);
  }
  return uids;
}

/** Member doc ids for one workflow (cascade deletion's filter). Pure. */
export function filterWorkflowMemberIds(
  docs: ReadonlyArray<{ id: string }>,
  workflowId: string,
): string[] {
  const prefix = `${workflowId}_`;
  return docs.filter((d) => d.id.startsWith(prefix)).map((d) => d.id);
}
