/**
 * Identity-read cache (Read-Burn Fix Program, workstream A, plan §2).
 *
 * In-process TTL cache for the authorization-relevant Firestore reads
 * behind src/lib/server/permissions.ts:
 *   - the per-uid identity bundle (roles/{uid} + users/{uid} projections)
 *   - permission docs (roleDefinitions/{slug}, permissions/{slug})
 *
 * Staleness bound (plan §2.2): IDENTITY_TTL_MS = 30_000, program-wide.
 * In-process writes bust synchronously (plan §2.5); any other write is
 * visible within the TTL. The TTL must never be raised without
 * re-opening plan §2.2.
 *
 * Failure semantics (plan §2.4): errors are NEVER cached and stale
 * values are NEVER served on error - a loader throw (including
 * RESOURCE_EXHAUSTED) deletes the in-flight entry, stores nothing, and
 * propagates to the caller, whose existing error handling applies.
 * A successful read of a MISSING doc (exists:false) is data, not an
 * error, and IS cached.
 *
 * Shape follows the phase1-flags pattern (module-level cache + test
 * reset hook) plus the workflow-cache in-flight promise dedupe.
 *
 * Cache partitioning: entries are partitioned by an opaque scope object
 * (the Firestore handle the loader reads through). Production has one
 * Admin SDK handle, so in practice the cache is keyed only by uid (or
 * collection:slug) as plan §2.4 requires; the partition only stops two
 * different handles (e.g. two test fakes) from answering for each other.
 * No token, email, role, or chapter ever enters a key.
 */

export const IDENTITY_TTL_MS = 30_000;

/** Hard safety cap on identity entries per scope (plan §2.3). */
const MAX_IDENTITY_ENTRIES = 1_000;

export interface IdentityBundle {
  roles: {
    exists: boolean;
    role: unknown;
    additionalRoles: unknown;
    expiresAt: unknown;
    expiresRoleKey: unknown;
    chapterId: unknown;
  } | null;
  users: {
    exists: boolean;
    role: unknown;
    displayRole: unknown;
    additionalRoles: unknown;
    isBanned: boolean;
    chapterId: unknown;
  } | null;
  loadedAt: number;
}

export interface PermissionDocEntry {
  exists: boolean;
  data: Record<string, unknown> | undefined;
}

interface CacheOptions {
  /** Clock injection (phase1-flags precedent): defaults to Date.now(). */
  now?: number;
  /** Partition key: the Firestore handle the loader reads through. */
  scope?: unknown;
}

interface ScopeState {
  identities: Map<string, IdentityBundle>;
  identityInflight: Map<string, Promise<IdentityBundle>>;
  permissionDocs: Map<string, PermissionDocEntry & { loadedAt: number }>;
  permissionInflight: Map<string, Promise<PermissionDocEntry>>;
}

const DEFAULT_SCOPE: object = {};
const scopes = new Map<unknown, ScopeState>();

function stateFor(scope: unknown): ScopeState {
  const key = scope ?? DEFAULT_SCOPE;
  let state = scopes.get(key);
  if (!state) {
    state = {
      identities: new Map(),
      identityInflight: new Map(),
      permissionDocs: new Map(),
      permissionInflight: new Map(),
    };
    scopes.set(key, state);
  }
  return state;
}

function allStates(): ScopeState[] {
  return [...scopes.values()];
}

/**
 * Load (or reuse) the identity bundle for `uid`. A fresh cached bundle
 * is returned without running `loader`; concurrent loads for the same
 * uid share one loader run. Loader errors propagate and are not cached.
 */
export async function getIdentityBundle(
  uid: string,
  loader: () => Promise<IdentityBundle>,
  opts: CacheOptions = {},
): Promise<IdentityBundle> {
  const now = opts.now ?? Date.now();
  const state = stateFor(opts.scope);
  const hit = state.identities.get(uid);
  if (hit && now - hit.loadedAt < IDENTITY_TTL_MS) return hit;
  const inflight = state.identityInflight.get(uid);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const bundle = await loader();
      // The loader stamps loadedAt itself (its own clock read); keep it.
      state.identities.set(uid, bundle);
      if (state.identities.size > MAX_IDENTITY_ENTRIES) {
        // Evict the oldest insertion (Map iteration order).
        const oldest = state.identities.keys().next().value;
        if (oldest !== undefined && oldest !== uid) state.identities.delete(oldest);
      }
      return bundle;
    } finally {
      state.identityInflight.delete(uid);
    }
  })();
  state.identityInflight.set(uid, promise);
  return promise;
}

/**
 * Load (or reuse) one permission doc. Same TTL, same failure semantics
 * as the identity bundle: throws propagate uncached; exists:false is a
 * legitimate cached answer.
 */
export async function getPermissionDoc(
  collection: 'roleDefinitions' | 'permissions',
  slug: string,
  loader: () => Promise<PermissionDocEntry>,
  opts: CacheOptions = {},
): Promise<PermissionDocEntry> {
  const now = opts.now ?? Date.now();
  const state = stateFor(opts.scope);
  const key = `${collection}:${slug}`;
  const hit = state.permissionDocs.get(key);
  if (hit && now - hit.loadedAt < IDENTITY_TTL_MS) {
    return { exists: hit.exists, data: hit.data };
  }
  const inflight = state.permissionInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const entry = await loader();
      state.permissionDocs.set(key, { ...entry, loadedAt: now });
      return entry;
    } finally {
      state.permissionInflight.delete(key);
    }
  })();
  state.permissionInflight.set(key, promise);
  return promise;
}

/** Drop one uid's identity entries (settled + in-flight), every scope. */
export function bustIdentity(uid: string): void {
  for (const state of allStates()) {
    state.identities.delete(uid);
    state.identityInflight.delete(uid);
  }
}

/** Drop every identity entry, every scope. */
export function bustAllIdentities(): void {
  for (const state of allStates()) {
    state.identities.clear();
    state.identityInflight.clear();
  }
}

/** Drop one permission-doc entry (settled + in-flight), every scope. */
export function bustPermissionDoc(
  collection: 'roleDefinitions' | 'permissions',
  slug: string,
): void {
  const key = `${collection}:${slug}`;
  for (const state of allStates()) {
    state.permissionDocs.delete(key);
    state.permissionInflight.delete(key);
  }
}

/** Test hook, mirroring resetPhase1FlagsCache(). */
export function resetIdentityCache(): void {
  scopes.clear();
}
