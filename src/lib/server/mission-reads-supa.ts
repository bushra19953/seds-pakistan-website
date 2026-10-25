/**
 * mission-reads-supa.ts — the ONE seam module for the workflows
 * cluster group 1 (mission reads):
 *   src/app/api/missions/[workflowId]/route.ts
 *     tasks where workflowId == X, fallback tasks doc get,
 *     users doc gets, chapters doc gets.
 *
 * Pattern copied exactly from the sanctioned wf-4 seam
 * (src/lib/server/workflow-members-supa.ts on feat/supa-wf-4):
 * lazy dynamic import of '@/lib/supa' via a variable specifier,
 * locally declared mirror types, a loadSupaModule() with a
 * __set...LoaderForTests injection hook, and the gate
 *   useSupa('workflows') && getSupaClient() -> getSupaAdapter()
 * returning null on ANY failure.
 *
 * Contract, aligned to the landed adapter
 * (feat/supa-adapter, src/lib/supa/):
 * - Surface string is exactly 'workflows'. Flag default OFF;
 *   getSupaClient() returns null when unconfigured (never throws).
 * - Any gate failure, unconfigured client, or adapter error makes
 *   every helper here return null, and the caller falls back to
 *   EXACTLY today's Firestore path (byte-identical result set).
 * - Only READS live here.
 *
 * The adapter is NOT present in this base tree and must not be merged
 * or cherry-picked into it, so it is reached through the lazy dynamic
 * import typed against the locally declared SupaAdapterLike mirror
 * below. That keeps tsc/jest green while the module is absent and
 * resolves to null when unavailable. MERGE-TIME: once
 * src/lib/supa/index.ts lands it exports exactly the three functions
 * used here with the shapes declared here; no seam code change is
 * needed.
 *
 * Timestamp care (the byte-identity pin): adapter docs carry
 * SupaTimestamp for dumped timestamp fields (seconds / nanoseconds /
 * toDate() / toMillis()), which the route's serializeTs already
 * handles via its toDate() branch; ISO strings (the jsonb shape in
 * the wf-6 fixtures) pass serializeTs through unchanged, exactly like
 * Firestore Timestamp objects do after toDate(). As a safety net for
 * an adapter-shaped doc that still carries a raw dumped timestamp
 * ({_seconds,_nanoseconds} plain object — serializeTs would leak it
 * verbatim, since it checks `.seconds`, not `._seconds`), this seam
 * revives that exact shape into a Timestamp-like object before the
 * route ever sees it. Values that already expose toDate()/toMillis()
 * (Firestore Timestamp, SupaTimestamp) and all other values pass
 * through untouched.
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
export function __setMissionReadsSupaLoaderForTests(loader: SupaLoader | null): void {
  loaderOverride = loader;
  cachedModule = null;
}

/**
 * The adapter when the 'workflows' surface is ON and a client is
 * configured; null otherwise (module absent / flag OFF / no client /
 * factory throws). This is the coordinator's gate pattern verbatim:
 * `useSupa('workflows') && getSupaClient()` -> `getSupaAdapter()`.
 */
export async function getMissionReadsSupaAdapter(): Promise<SupaAdapterLike | null> {
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

/* ------------------------------------------------------- timestamp revival */

/** The legacy dumped shape: exactly {_seconds, _nanoseconds}, both numeric. */
function isDumpedTimestamp(value: unknown): value is { _seconds: number; _nanoseconds: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 2 &&
    typeof v._seconds === 'number' &&
    typeof v._nanoseconds === 'number' &&
    Number.isFinite(v._seconds) &&
    Number.isFinite(v._nanoseconds)
  );
}

/**
 * Deep revival of raw dumped timestamps into a Timestamp-like object
 * exposing seconds / nanoseconds / toDate() / toMillis() — the exact
 * surface the route's serializeTs consumes. Everything else recurses
 * or passes through untouched (ISO strings stay strings; objects
 * already exposing toDate()/toMillis() are returned as-is).
 */
export function reviveDumpedTimestamps(value: unknown): unknown {
  if (isDumpedTimestamp(value)) {
    const seconds = value._seconds;
    const nanoseconds = value._nanoseconds;
    const millis = seconds * 1000 + nanoseconds / 1_000_000;
    return {
      seconds,
      nanoseconds,
      toMillis: () => millis,
      toDate: () => new Date(millis),
      toISOString: () => new Date(millis).toISOString(),
    };
  }
  if (Array.isArray(value)) return value.map(reviveDumpedTimestamps);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.toDate === 'function' || typeof obj.toMillis === 'function') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = reviveDumpedTimestamps(v);
    return out;
  }
  return value;
}

/* -------------------------------------------------------------- doc shapes */

/** A step/task doc in the exact shape the route consumes: { id, data }. */
export interface MissionDoc {
  id: string;
  data: Record<string, unknown>;
}

/** A single-doc read in Firestore-snapshot shape: { id, exists, data }. */
export interface MissionDocSnapshot {
  id: string;
  exists: boolean;
  data: Record<string, unknown> | undefined;
}

function toMissionDoc(doc: SupaDoc): MissionDoc | null {
  if (!doc || typeof doc.id !== 'string') return null;
  const { id, ...rest } = doc;
  return { id, data: reviveDumpedTimestamps(rest) as Record<string, unknown> };
}

/* --------------------------------------------------------------- seam reads */

/**
 * Every tasks doc with workflowId == workflowId, as Firestore-shaped
 * `{ id, data }` objects, or null when the Supa path is not available
 * (gate failure / adapter error) and the caller must use Firestore.
 * An empty array is a REAL result (the mission does not exist on the
 * Supa path), never a fallback signal.
 */
export async function listMissionStepsViaSupa(workflowId: string): Promise<MissionDoc[] | null> {
  const adapter = await getMissionReadsSupaAdapter();
  if (!adapter) return null;
  try {
    const docs = await adapter.listDocs(TASKS_COLLECTION, {
      where: [['workflowId', '==', workflowId]],
    });
    if (!Array.isArray(docs)) return null;
    const out: MissionDoc[] = [];
    for (const d of docs) {
      const doc = toMissionDoc(d as SupaDoc);
      if (!doc) return null;
      out.push(doc);
    }
    return out;
  } catch {
    // SupaAdapterError / SupaUnavailableError / anything: Firestore fallback.
    return null;
  }
}

/**
 * One doc (tasks / users / chapters) as a Firestore-shaped snapshot
 * `{ id, exists, data }`, or null when the Supa path is not available
 * and the caller must use Firestore for this read. A missing doc is
 * a REAL result: { exists: false, data: undefined }.
 */
export async function getMissionDocViaSupa(
  collection: string,
  id: string,
): Promise<MissionDocSnapshot | null> {
  const adapter = await getMissionReadsSupaAdapter();
  if (!adapter) return null;
  try {
    const doc = await adapter.getDoc(collection, id);
    if (doc === null || doc === undefined) return { id, exists: false, data: undefined };
    const missionDoc = toMissionDoc(doc as SupaDoc);
    if (!missionDoc) return null;
    return { id: missionDoc.id, exists: true, data: missionDoc.data };
  } catch {
    // SupaAdapterError / SupaUnavailableError / anything: Firestore fallback.
    return null;
  }
}
