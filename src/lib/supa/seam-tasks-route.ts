/**
 * seam-tasks-route.ts — the ONE Supabase seam for src/app/api/tasks/route.ts.
 *
 * All Supabase access for the main tasks route lives here. The route file
 * itself contains no adapter references; it only calls the functions below.
 *
 * Behavior contract:
 * - Flag OFF (default), adapter absent/unconfigured, or adapter load failure
 *   -> resolveTasksSupaAdapter() returns null and every read/write in the
 *   route falls back to EXACTLY today's Firestore behavior.
 * - Flag ON + adapter present: GET list reads go through listTasksDocs();
 *   writes stay on Firestore and are mirrored via mirrorTaskDocById /
 *   mirrorTaskDocsByIds / mirrorTaskDeletesByIds. Mirror functions NEVER
 *   throw: a mirror failure is logged and the request proceeds.
 * - Every list query this seam issues carries a finite positive limit.
 *   listTasksDocs() throws rather than issuing an unbounded read.
 *
 * The real adapter (src/lib/supa/adapter, built in parallel) is NOT in this
 * tree. It is reached through a lazy dynamic import with a variable
 * specifier so tsc stays clean on this base, typed against the locally
 * declared TasksSupaAdapter interface matching the adapter contract.
 * At merge time the default specifier is re-pointed at the real
 * '@/lib/supa/adapter'. See supa-rebase-notes/tasks-1.md.
 */

/** One where clause: [field, operator, value], Firestore-style operators. */
export type SupaWhereClause = [field: string, op: string, value: any];

export interface SupaListOptions {
  where?: SupaWhereClause[];
  orderBy?: [field: string, direction: 'asc' | 'desc'] | string;
  limit: number;
  startAfter?: any;
}

/**
 * The adapter contract (src/lib/supa/adapter, parallel workstream).
 * Results are Firestore-shaped plain objects: { id, ...data }.
 */
export interface TasksSupaAdapter {
  getDoc(collection: string, id: string): Promise<Record<string, any> | null>;
  listDocs(collection: string, options: SupaListOptions): Promise<Array<Record<string, any>>>;
  countDocs(collection: string, where?: SupaWhereClause[]): Promise<number>;
  setDoc(collection: string, id: string, data: Record<string, any>): Promise<void>;
  updateDoc(collection: string, id: string, data: Record<string, any>): Promise<void>;
  deleteDoc(collection: string, id: string): Promise<void>;
}

export const TASKS_SUPA_SURFACE = 'tasks';
export const TASKS_COLLECTION = 'tasks';

/**
 * useSupa(surface) equivalent for this tree: env-driven via the
 * SUPA_SURFACES comma-separated list, default OFF for every surface.
 * At merge time this can be swapped for the adapter's useSupa helper.
 */
export function isTasksSupaFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SUPA_SURFACES || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(TASKS_SUPA_SURFACE);
}

// ---------------------------------------------------------------------------
// Adapter resolution (lazy, cached, test-injectable)
// ---------------------------------------------------------------------------

let injectedAdapter: TasksSupaAdapter | null | undefined;
let adapterPromise: Promise<TasksSupaAdapter | null> | null = null;

/** Test-only: inject a mocked adapter (or null to simulate absence). */
export function __setTasksSupaAdapterForTests(adapter: TasksSupaAdapter | null): void {
  injectedAdapter = adapter;
  adapterPromise = null;
}

/** Test-only: clear injection and the cached adapter promise. */
export function __resetTasksSupaAdapterForTests(): void {
  injectedAdapter = undefined;
  adapterPromise = null;
}

async function loadAdapterModule(): Promise<TasksSupaAdapter | null> {
  // Variable specifier on purpose: the adapter module does not exist in
  // this tree, so a static/literal import would fail tsc and the build.
  // At merge time this resolves to '@/lib/supa/adapter'.
  const specifier: string = process.env.SUPA_ADAPTER_SPECIFIER || '@/lib/supa/adapter';
  try {
    const mod: any = await import(/* webpackIgnore: true */ specifier);
    const candidate: any = mod?.default ?? mod?.adapter ?? mod;
    if (
      candidate &&
      typeof candidate.listDocs === 'function' &&
      typeof candidate.setDoc === 'function' &&
      typeof candidate.deleteDoc === 'function'
    ) {
      return candidate as TasksSupaAdapter;
    }
    console.warn('[supa-seam:tasks] Adapter module loaded but does not match the contract; staying on Firestore');
    return null;
  } catch (err) {
    // Absent or unconfigured adapter is an expected state in this wave:
    // the route keeps its exact Firestore behavior.
    console.warn('[supa-seam:tasks] Adapter unavailable; staying on Firestore', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolve the adapter for this surface, or null when the surface flag is
 * OFF, the adapter is absent/unconfigured, or loading it failed.
 * Returning null always means: use the Firestore path, unchanged.
 */
export async function resolveTasksSupaAdapter(): Promise<TasksSupaAdapter | null> {
  if (!isTasksSupaFlagOn()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (!adapterPromise) adapterPromise = loadAdapterModule();
  return adapterPromise;
}

// ---------------------------------------------------------------------------
// Timestamp normalization
//
// Task docs carry Firestore Timestamps on the Firestore path. From jsonb
// they come back as ISO strings (or {seconds, nanoseconds} plain objects).
// Consumers in the route call .toDate() / .toMillis() and read .seconds,
// so seam-served docs get their known timestamp fields wrapped in a
// Firestore-Timestamp-shaped value implementing exactly that surface.
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
      // Already Timestamp-like (defensive; jsonb never produces this).
      return value as SeamTimestamp;
    }
    if (typeof value.seconds === 'number') {
      const ms = value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
      return makeSeamTimestamp(ms);
    }
    if (typeof value._seconds === 'number') {
      const ms = value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
      return makeSeamTimestamp(ms);
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
  'releasedAt',
  'submittedAt',
  'approvedAt',
  'rejectedAt',
  'acceptedAt',
  'startedAt',
  'availabilityConfirmedAt',
  'lastTaskAssignedAt',
];

/**
 * Normalize one seam-served task doc in place-shape (returns a new object):
 * known timestamp fields become SeamTimestamps; acceptanceBy entries get
 * the same treatment for their acceptedAt; feedback_history timestamps too.
 * Null stays null (the route's serializer maps null to null, as Firestore
 * docs with explicit nulls do today).
 */
export function normalizeTaskDocData(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...data };
  for (const field of TASK_TIMESTAMP_FIELDS) {
    if (out[field] != null) {
      const ts = toSeamTimestamp(out[field]);
      if (ts) out[field] = ts;
    }
  }
  if (out.acceptanceBy && typeof out.acceptanceBy === 'object' && !Array.isArray(out.acceptanceBy)) {
    const map: Record<string, any> = {};
    for (const [uid, entry] of Object.entries(out.acceptanceBy)) {
      if (entry && typeof entry === 'object' && (entry as any).acceptedAt != null) {
        const ts = toSeamTimestamp((entry as any).acceptedAt);
        map[uid] = ts ? { ...(entry as any), acceptedAt: ts } : entry;
      } else {
        map[uid] = entry;
      }
    }
    out.acceptanceBy = map;
  }
  if (Array.isArray(out.feedback_history)) {
    out.feedback_history = out.feedback_history.map((entry: any) => {
      if (entry && typeof entry === 'object' && entry.timestamp != null) {
        const ts = toSeamTimestamp(entry.timestamp);
        if (ts) return { ...entry, timestamp: ts };
      }
      return entry;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot-shaped docs: the route's existing code consumes
// { id, data(), get(field) } — seam reads return exactly that shape.
// ---------------------------------------------------------------------------

export interface SeamSnapshotDoc {
  id: string;
  exists: true;
  data(): Record<string, any>;
  get(field: string): any;
}

export function toSnapshotDoc(raw: Record<string, any>): SeamSnapshotDoc {
  const { id, ...rest } = raw || {};
  const data = normalizeTaskDocData(rest);
  return {
    id: String(id ?? ''),
    exists: true,
    data: () => data,
    get: (field: string) => data[field],
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Bounded list read over the tasks collection via the adapter.
 * Throws if no positive finite limit is supplied — an unbounded read
 * through this seam is a programming error, never a fallback.
 * Adapter errors propagate: the route's ladder decides what happens next.
 */
export async function listTasksDocs(
  adapter: TasksSupaAdapter,
  options: SupaListOptions
): Promise<SeamSnapshotDoc[]> {
  if (!options || typeof options.limit !== 'number' || !Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error('[supa-seam:tasks] listTasksDocs requires a finite positive limit (unbounded reads are forbidden)');
  }
  const rows = await adapter.listDocs(TASKS_COLLECTION, {
    where: options.where,
    orderBy: options.orderBy,
    limit: options.limit,
    startAfter: options.startAfter,
  });
  return (rows || []).map((row) => toSnapshotDoc(row));
}

// ---------------------------------------------------------------------------
// Mirror-on-write (never throws)
// ---------------------------------------------------------------------------

/**
 * Deep-sanitize a Firestore-shaped doc for jsonb storage:
 * Timestamp-like values and Dates become ISO strings; FieldValue
 * sentinels (serverTimestamp / increment / delete / arrayUnion — objects
 * carrying a `_methodName`) are dropped, since they have no jsonb meaning;
 * undefined values are dropped. Plain objects and arrays recurse.
 */
export function sanitizeForMirror(value: any): any {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof value._methodName === 'string') return undefined;
    if (typeof value.toDate === 'function') {
      try {
        return value.toDate().toISOString();
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeForMirror(v)).filter((v) => v !== undefined);
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const sv = sanitizeForMirror(v);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return value;
}

/**
 * Mirror one task doc to Supabase by re-reading its final Firestore state
 * through `fetchData` (invoked ONLY when mirroring is actually active, so
 * flag-OFF requests pay zero extra reads). Never throws.
 */
export async function mirrorTaskDocById(
  id: string,
  fetchData: () => Promise<Record<string, any> | undefined>
): Promise<void> {
  try {
    const adapter = await resolveTasksSupaAdapter();
    if (!adapter) return;
    const data = await fetchData();
    if (!data) return;
    await adapter.setDoc(TASKS_COLLECTION, id, sanitizeForMirror(data));
  } catch (err) {
    console.warn(`[supa-seam:tasks] Mirror upsert failed for task ${id} (non-blocking):`, err);
  }
}

/** Mirror several task docs (e.g. workflow step docs written by PATCH). */
export async function mirrorTaskDocsByIds(
  ids: string[],
  fetchDataById: (id: string) => Promise<Record<string, any> | undefined>
): Promise<void> {
  const unique = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  for (const id of unique) {
    await mirrorTaskDocById(id, () => fetchDataById(id));
  }
}

/** Mirror deletes (master task or removed workflow step docs). Never throws. */
export async function mirrorTaskDeletesByIds(ids: string[]): Promise<void> {
  try {
    const adapter = await resolveTasksSupaAdapter();
    if (!adapter) return;
    const unique = Array.from(new Set((ids || []).map(String).filter(Boolean)));
    for (const id of unique) {
      try {
        await adapter.deleteDoc(TASKS_COLLECTION, id);
      } catch (err) {
        console.warn(`[supa-seam:tasks] Mirror delete failed for task ${id} (non-blocking):`, err);
      }
    }
  } catch (err) {
    console.warn('[supa-seam:tasks] Mirror delete failed (non-blocking):', err);
  }
}
