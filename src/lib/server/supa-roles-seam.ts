/**
 * Supabase seam for the ROLES + PERMISSIONS cluster (file-group 1:
 * server identity + role resolution core).
 *
 * This is the ONLY module in this file-group that knows Supabase
 * exists. Every migrated read/write in:
 *   - src/lib/server/permissions.ts  (identity bundle roles half,
 *     permission-doc walk)
 *   - src/lib/role-definitions.ts    (client/shared roleDefinitions
 *     list read + definition upsert mirror)
 * goes through here, so re-pointing at the real adapter
 * (src/lib/supa/, branch feat/supa-adapter, in flight at the time this
 * seam was written) is a one-file edit: implement `loadAdapter()` /
 * the SupaAdapter interface below against its exports.
 *
 * ADAPTER CONTRACT (as shipped on feat/supa-adapter, reconciled at
 * merge — parity matrix row R19):
 *   - Tables fs_<collection> (id text pk, firebase_uid, parent_path,
 *     data jsonb).
 *   - Object API: getSupaAdapter() -> { getDoc, listDocs, countDocs,
 *     setDoc, updateDoc, deleteDoc } over those tables, returning
 *     flattened docs ({ id, ...fields }) or null for missing.
 *     loadAdapter() below translates that onto this seam's
 *     { exists, data } interface.
 *   - useSupa(surface) env-flag helper, default OFF.
 * The seam tolerates ANY of: module absent, module present but client
 * unconfigured, function missing, or call throwing. In every such case
 * it reports "unavailable" and callers take the Firestore path
 * EXACTLY as before this migration. Flag OFF is byte-identical to
 * pre-migration behaviour: the adapter is never even consulted for a
 * data call (only the cheap flag check runs).
 *
 * Return-shape contract:
 *   - supaGetDoc  -> { exists, data } | null   (null = unavailable,
 *     fall back to Firestore; a missing doc is { exists:false },
 *     NEVER null, so absence in Supabase is data, not a fallback)
 *   - supaListDocs -> Array<{ id, data }> | null
 *   - mirror writes are best-effort: they return boolean success and
 *     NEVER throw into the caller's Firestore-primary write path.
 */

export interface SupaDoc {
  exists: boolean;
  data: Record<string, unknown> | undefined;
}

export interface SupaAdapter {
  useSupa?: (surface: string) => boolean;
  getDoc?: (
    collection: string,
    id: string,
  ) => Promise<{ exists: boolean; data?: Record<string, unknown> | null } | null | undefined>;
  listDocs?: (
    collection: string,
    opts?: Record<string, unknown>,
  ) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  setDoc?: (collection: string, id: string, data: Record<string, unknown>) => Promise<void>;
  updateDoc?: (collection: string, id: string, data: Record<string, unknown>) => Promise<void>;
  deleteDoc?: (collection: string, id: string) => Promise<void>;
}

/** Collections this file-group owns. `users` is deliberately absent:
 * another cluster owns it; the identity bundle's users half always
 * stays on Firestore. */
export type SupaRolesCollection = 'roles' | 'roleDefinitions' | 'permissions' | 'role_permissions';

/** Test injection point (mock only; no live client is ever built in
 * tests). Passing null restores the real dynamic adapter lookup. */
let injectedAdapter: SupaAdapter | null | undefined;
export function __setSupaAdapterForTests(adapter: SupaAdapter | null): void {
  injectedAdapter = adapter;
}

let cachedAdapter: SupaAdapter | null | undefined;
async function loadAdapter(): Promise<SupaAdapter | null> {
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (cachedAdapter !== undefined) return cachedAdapter;
  try {
    // R19 SHIM — landed at merge (step 3), per
    // ROLES_RESOLUTION_PARITY_MATRIX.md row R19. The shipped adapter
    // (src/lib/supa) exposes an OBJECT API, not the module-level
    // { exists, data } functions this seam was written against:
    // getSupaAdapter() returns { getDoc, listDocs, countDocs, setDoc,
    // updateDoc, deleteDoc } whose reads return FLATTENED docs
    // ({ id, ...fields }) or null for a missing doc, and whose calls
    // throw (SupaUnavailableError) when the client is unconfigured.
    // The translation lives here, in this one place:
    //   adapter null (missing doc) -> { exists: false } — absence is
    //     data, never the fallback signal;
    //   flattened doc -> { exists: true, data } with `id` stripped —
    //     callers expect the stored fields only, exactly what
    //     Firestore's doc.data() returns;
    //   listDocs rows -> { id, data } pairs, same stripping;
    //   writes delegate and discard the returned doc;
    //   adapter throws propagate into the calling wrapper, whose
    //     try/catch converts them to null/false (Firestore fallback),
    //     preserving this seam's documented failure semantics.
    // Variable specifier kept on purpose: it preserves the seam's
    // module-absent tolerance and the test-injection path unchanged.
    const specifier = '@/lib/supa';
    const mod = (await import(/* webpackIgnore: true */ specifier)) as Record<string, unknown>;
    if (typeof mod.getSupaAdapter !== 'function') {
      cachedAdapter = null;
      return cachedAdapter;
    }
    type RealAdapter = {
      getDoc: (collection: string, id: string) => Promise<Record<string, unknown> | null>;
      listDocs: (
        collection: string,
        opts?: Record<string, unknown>,
      ) => Promise<Array<Record<string, unknown>>>;
      setDoc: (collection: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
      updateDoc: (collection: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
      deleteDoc: (collection: string, id: string) => Promise<unknown>;
    };
    const real = (mod.getSupaAdapter as () => RealAdapter)();
    const stripId = (doc: Record<string, unknown>): Record<string, unknown> => {
      const { id: _docId, ...data } = doc;
      return data;
    };
    cachedAdapter = {
      useSupa: typeof mod.useSupa === 'function' ? (mod.useSupa as SupaAdapter['useSupa']) : undefined,
      getDoc: async (collection, id) => {
        const doc = await real.getDoc(collection, id);
        if (doc == null) return { exists: false };
        return { exists: true, data: stripId(doc) };
      },
      listDocs: async (collection, opts) => {
        const docs = await real.listDocs(collection, opts);
        return docs.map((doc) => ({ id: String(doc.id), data: stripId(doc) }));
      },
      setDoc: async (collection, id, data) => {
        await real.setDoc(collection, id, data);
      },
      updateDoc: async (collection, id, data) => {
        await real.updateDoc(collection, id, data);
      },
      deleteDoc: async (collection, id) => {
        await real.deleteDoc(collection, id);
      },
    };
  } catch {
    cachedAdapter = null;
  }
  return cachedAdapter;
}

/** Synchronous flag answer for the injected-adapter path (tests) plus
 * the env-only fallback when no adapter is loaded yet. Async callers
 * should prefer supaEnabledFor(). Default OFF in all states. */
function envFlagFor(surface: string): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  const norm = surface.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  const v =
    process.env[`SUPA_${norm}`] ?? process.env.SUPA_ALL ?? process.env.NEXT_PUBLIC_SUPA_ALL;
  return v === '1' || v === 'true';
}

/**
 * Is Supabase authoritative for reads of `surface` right now?
 * True only when an adapter exists AND its useSupa (or the env
 * fallback) says so. Never throws.
 */
export async function supaEnabledFor(surface: string): Promise<boolean> {
  try {
    const adapter = await loadAdapter();
    if (!adapter) return false;
    if (typeof adapter.useSupa === 'function') return adapter.useSupa(surface) === true;
    return envFlagFor(surface);
  } catch {
    return false;
  }
}

/** Synchronous variant for the client list reader: only the injected
 * adapter or an already-loaded adapter can say yes; otherwise env.
 * (The client reader awaits supaEnabledFor before deciding anyway;
 * this exists for callers that cannot await a flag check twice.) */
export function supaEnabledSyncFor(surface: string): boolean {
  const adapter = injectedAdapter !== undefined ? injectedAdapter : cachedAdapter;
  if (adapter && typeof adapter.useSupa === 'function') {
    try {
      return adapter.useSupa(surface) === true;
    } catch {
      return false;
    }
  }
  if (adapter) return envFlagFor(surface);
  return false;
}

/**
 * Read one doc from Supabase. Returns null when the flag is OFF, the
 * adapter is unavailable/unconfigured, or the call errors - the
 * caller then takes the Firestore path exactly as today. A genuinely
 * missing doc returns { exists:false, data:undefined }.
 */
export async function supaGetDoc(
  collection: SupaRolesCollection,
  id: string,
): Promise<SupaDoc | null> {
  try {
    if (!(await supaEnabledFor(collection))) return null;
    const adapter = await loadAdapter();
    if (!adapter?.getDoc) return null;
    const result = await adapter.getDoc(collection, id);
    if (result == null) return null;
    if (!result.exists) return { exists: false, data: undefined };
    return { exists: true, data: (result.data ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** List a whole (small) collection from Supabase, or null to fall back. */
export async function supaListDocs(
  collection: SupaRolesCollection,
): Promise<Array<{ id: string; data: Record<string, unknown> }> | null> {
  try {
    if (!(await supaEnabledFor(collection))) return null;
    const adapter = await loadAdapter();
    if (!adapter?.listDocs) return null;
    const rows = await adapter.listDocs(collection);
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => ({ id: String(r.id), data: (r.data ?? {}) as Record<string, unknown> }));
  } catch {
    return null;
  }
}

/**
 * Mirror-on-write helpers. Firestore stays primary; these run only
 * when the flag is ON and NEVER throw - a failed mirror must not fail
 * the Firestore write that already committed.
 */
export async function supaMirrorSet(
  collection: SupaRolesCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (!(await supaEnabledFor(collection))) return false;
    const adapter = await loadAdapter();
    if (!adapter?.setDoc) return false;
    await adapter.setDoc(collection, id, data);
    return true;
  } catch {
    return false;
  }
}

export async function supaMirrorUpdate(
  collection: SupaRolesCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (!(await supaEnabledFor(collection))) return false;
    const adapter = await loadAdapter();
    if (adapter?.updateDoc) {
      await adapter.updateDoc(collection, id, data);
      return true;
    }
    if (adapter?.setDoc) {
      await adapter.setDoc(collection, id, data);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function supaMirrorDelete(
  collection: SupaRolesCollection,
  id: string,
): Promise<boolean> {
  try {
    if (!(await supaEnabledFor(collection))) return false;
    const adapter = await loadAdapter();
    if (!adapter?.deleteDoc) return false;
    await adapter.deleteDoc(collection, id);
    return true;
  } catch {
    return false;
  }
}
