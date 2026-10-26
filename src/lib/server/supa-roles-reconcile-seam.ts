/**
 * Supabase seam for the ROLES cluster G4 (cron / reconciliation data
 * paths).
 *
 * This is the ONLY module in this file-group that knows Supabase
 * exists. Every migrated read in:
 *   - src/lib/server/role-reconciliation.ts      (roles / users /
 *     roleHistory full-collection reads)
 *   - src/lib/server/custom-role-expiry-sweep.ts (roles full read,
 *     roleDefinitions + users doc gets, expiryAlertStage mirror)
 * goes through here, so re-pointing at the real adapter
 * (src/lib/supa/, branch feat/supa-adapter) is a one-file concern:
 * `loadAdapter()` below already speaks to its exports.
 *
 * REAL ADAPTER CONTRACT (branch feat/supa-adapter,
 * src/lib/supa/adapter.ts + flags.ts):
 *   - The module '@/lib/supa' exports getSupaAdapter() ->
 *     { getDoc, listDocs, countDocs, setDoc, updateDoc, deleteDoc }
 *     and useSupa(surface).
 *   - getDoc(collection, id) returns a FLATTENED doc
 *     { id, ...fields } or null for a missing doc.
 *   - listDocs(collection, opts?) returns flattened docs; opts is the
 *     adapter's ListOptions shape (where tuples
 *     [[field, op, value]], orderBy, limit, startAfter).
 *   - useSupa('roles') is the engagement flag for this file-group
 *     (default OFF; SUPA_SURFACES env list).
 *
 * SHAPE TRANSLATION (parity-matrix row R19): this seam translates the
 * adapter's flattened docs back to Firestore-shaped results, so
 * callers see exactly the shapes they saw from Firestore:
 *   - supaGetDoc  -> { exists: true, data } | { exists: false } | null
 *     (adapter null = the doc is missing in Supabase: that is DATA,
 *     never a fallback signal; `data` is the flattened doc with its
 *     `id` key stripped, passed through verbatim)
 *   - supaListDocs -> Array<{ id, data }> | null
 *   - supaMirrorUpdate -> best-effort boolean, NEVER throws.
 * A null return from supaGetDoc / supaListDocs means "seam
 * unavailable" ONLY: module absent, no client configured, flag OFF,
 * or the adapter call threw. In every such case the caller takes its
 * base Firestore path byte-identically. Flag OFF is byte-identical to
 * pre-migration behaviour: no adapter DATA call is ever made.
 *
 * No instanceof Timestamp logic lives here (or is needed): field
 * values pass through verbatim in both directions.
 */

import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';

/* ------------------------------------------------------------------ types */

export type SupaRolesReconcileCollection =
  | 'roles'
  | 'users'
  | 'roleHistory'
  | 'roleDefinitions';

/** The adapter's ListOptions shape (feat/supa-adapter adapter.ts). */
export interface SupaListOptions {
  where?: Array<[field: string, op: string, value: unknown]>;
  orderBy?:
    | string
    | { field: string; direction?: 'asc' | 'desc' }
    | Array<{ field: string; direction?: 'asc' | 'desc' }>;
  limit?: number;
  startAfter?: string | number | Date | { toDate(): Date } | { toMillis(): number };
}

type FlattenedDoc = { id: string } & Record<string, unknown>;

/**
 * REAL adapter shape: what getSupaAdapter() returns on
 * feat/supa-adapter, plus the module's useSupa flag function (the
 * loader folds the module-level useSupa onto this object; an injected
 * test adapter may carry its own).
 */
export interface SupaRolesAdapter {
  useSupa?: (surface: string) => boolean;
  getDoc: (collection: string, id: string) => Promise<FlattenedDoc | null>;
  listDocs: (
    collection: string,
    opts?: SupaListOptions,
  ) => Promise<FlattenedDoc[]>;
  countDocs?: (
    collection: string,
    where?: Array<[field: string, op: string, value: unknown]>,
  ) => Promise<number>;
  setDoc?: (
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ) => Promise<unknown>;
  updateDoc?: (
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  deleteDoc?: (collection: string, id: string) => Promise<void>;
}

export interface SupaDocResult {
  exists: boolean;
  data: Record<string, unknown> | undefined;
}

/** The one surface this file-group engages on. */
const SURFACE = 'roles';

/* ------------------------------------------------------ adapter plumbing */

let injectedAdapter: SupaRolesAdapter | null | undefined;

/**
 * Test injection point. Pass a REAL-SHAPED fake adapter (getDoc
 * returns flattened docs or null, listDocs returns flattened docs).
 * Passing null clears the injection and restores the real
 * (statically imported) adapter lookup. Mocks/fakes only - no live client is ever built in
 * tests.
 */
export function __setSupaAdapterForTests(
  adapter: SupaRolesAdapter | null,
): void {
  injectedAdapter = adapter ?? undefined;
  if (adapter === null) injectedAdapter = undefined;
}

let cachedAdapter: SupaRolesAdapter | null | undefined;

async function loadAdapter(): Promise<SupaRolesAdapter | null> {
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (cachedAdapter !== undefined) return cachedAdapter;
  try {
    // STATIC import (live-defect fix): the previous webpackIgnore
    // dynamic import of the '@/lib/supa' alias never resolved in the
    // standalone server bundle, so this loader always failed and the
    // seam was adapter-dead in production. The statically imported
    // module always exists in this tree; module-absent tolerance is
    // replaced by the test-injection point above
    // (__setSupaAdapterForTests).
    // No configured client = seam unavailable (the adapter's own
    // methods would throw SupaUnavailableError per call; short-circuit
    // here keeps the fallback clean).
    if (typeof getSupaClient === 'function') {
      try {
        if (!getSupaClient()) {
          cachedAdapter = null;
          return cachedAdapter;
        }
      } catch {
        cachedAdapter = null;
        return cachedAdapter;
      }
    }

    let raw: Record<string, unknown> | null = null;
    if (typeof getSupaAdapter === 'function') {
      try {
        raw = getSupaAdapter() as unknown as Record<string, unknown>;
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      cachedAdapter = null;
      return cachedAdapter;
    }
    const adapter: SupaRolesAdapter = {
      useSupa:
        typeof useSupa === 'function'
          ? (useSupa as SupaRolesAdapter['useSupa'])
          : typeof raw.useSupa === 'function'
            ? (raw.useSupa as SupaRolesAdapter['useSupa'])
            : undefined,
      getDoc: raw.getDoc as SupaRolesAdapter['getDoc'],
      listDocs: raw.listDocs as SupaRolesAdapter['listDocs'],
      countDocs: raw.countDocs as SupaRolesAdapter['countDocs'],
      setDoc: raw.setDoc as SupaRolesAdapter['setDoc'],
      updateDoc: raw.updateDoc as SupaRolesAdapter['updateDoc'],
      deleteDoc: raw.deleteDoc as SupaRolesAdapter['deleteDoc'],
    };
    cachedAdapter =
      typeof adapter.getDoc === 'function' || typeof adapter.listDocs === 'function'
        ? adapter
        : null;
  } catch {
    cachedAdapter = null;
  }
  return cachedAdapter;
}

/** Env fallback matching the real useSupa semantics (SUPA_SURFACES
 * comma list, case-insensitive, '*' = all, unset = OFF). Used only
 * when a loaded/injected adapter carries no useSupa of its own and
 * the adapter did not come from test injection. */
function envFlagForRoles(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes(SURFACE);
}

async function supaEngaged(adapter: SupaRolesAdapter): Promise<boolean> {
  try {
    if (typeof adapter.useSupa === 'function') {
      return adapter.useSupa(SURFACE) === true;
    }
    // An injected adapter without a flag function is a test fake that
    // wants to be engaged; a real loaded adapter without one falls
    // back to the env flag.
    if (injectedAdapter !== undefined) return true;
    return envFlagForRoles();
  } catch {
    return false;
  }
}

/**
 * Is Supabase engaged for the 'roles' surface right now? True only
 * when an adapter loads AND its useSupa('roles') is true. Never
 * throws.
 */
export async function supaEnabledForRoles(): Promise<boolean> {
  try {
    const adapter = await loadAdapter();
    if (!adapter) return false;
    return await supaEngaged(adapter);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ translation */

function splitFlattened(
  doc: FlattenedDoc,
): { id: string; data: Record<string, unknown> } {
  const { id, ...data } = doc as Record<string, unknown>;
  return { id: String(id), data };
}

/* -------------------------------------------------------------- seam API */

/**
 * Read one doc through the seam, Firestore-shaped.
 *   { exists: true, data }  - doc present (data verbatim, id stripped)
 *   { exists: false }       - adapter answered null: doc missing in
 *                             Supabase. This is DATA, never a fallback.
 *   null                    - seam unavailable (module absent / no
 *                             client / flag OFF / adapter threw):
 *                             caller takes the base Firestore path.
 */
export async function supaGetDoc(
  collection: SupaRolesReconcileCollection,
  id: string,
): Promise<SupaDocResult | null> {
  try {
    const adapter = await loadAdapter();
    if (!adapter || typeof adapter.getDoc !== 'function') return null;
    if (!(await supaEngaged(adapter))) return null;
    const doc = await adapter.getDoc(collection, id);
    if (doc == null) return { exists: false, data: undefined };
    return { exists: true, data: splitFlattened(doc).data };
  } catch {
    return null;
  }
}

/**
 * List a collection through the seam as Firestore-shaped
 * Array<{ id, data }>, or null when the seam is unavailable (caller
 * takes the base Firestore path). `opts` is passed through in the
 * adapter's ListOptions shape.
 */
export async function supaListDocs(
  collection: SupaRolesReconcileCollection,
  opts?: SupaListOptions,
): Promise<Array<{ id: string; data: Record<string, unknown> }> | null> {
  try {
    const adapter = await loadAdapter();
    if (!adapter || typeof adapter.listDocs !== 'function') return null;
    if (!(await supaEngaged(adapter))) return null;
    const rows = await adapter.listDocs(collection, opts);
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => splitFlattened(r));
  } catch {
    return null;
  }
}

/**
 * Best-effort mirror of a Firestore-primary update into Supabase.
 * Returns true only when the adapter accepted the update. NEVER
 * throws and never engages when the flag is OFF - a failed or skipped
 * mirror must not fail the Firestore write that already committed.
 */
export async function supaMirrorUpdate(
  collection: SupaRolesReconcileCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const adapter = await loadAdapter();
    if (!adapter) return false;
    if (!(await supaEngaged(adapter))) return false;
    if (typeof adapter.updateDoc === 'function') {
      await adapter.updateDoc(collection, id, data);
      return true;
    }
    if (typeof adapter.setDoc === 'function') {
      await adapter.setDoc(collection, id, data, { merge: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
