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
 * Generation/epoch protocol (plan §2.3 C-1, security review S2-4) -
 * closes the in-flight resurrection race for BOTH caches:
 *   1. A loader captures its key's generation BEFORE it starts and
 *      records it with the in-flight entry.
 *   2. Every bust (bustIdentity / bustPermissionDoc / bustAllIdentities)
 *      deletes the key's settled + in-flight entries AND increments
 *      the key's generation. Deleting the in-flight entry does not
 *      cancel its promise; the generation is what neutralizes it.
 *   3. A resolving loader stores its result ONLY if its captured
 *      generation still equals the current generation; otherwise the
 *      result is discarded and never enters the settled cache. (Waiters
 *      who joined the load BEFORE the bust may still receive that
 *      load's value for their own in-progress call - the same semantics
 *      as a request that had already passed verifyAuthentication when
 *      the write committed - but it is never stored, and it can never
 *      overwrite a post-bust entry.)
 *   4. A caller arriving AFTER a bust never joins a pre-bust promise:
 *      the bust deleted the in-flight entry, so it starts (or joins) a
 *      fresh load under the new generation.
 * In-flight cleanup on settle is identity-checked: a stale promise's
 * cleanup compares the stored entry's promise against its own before
 * deleting, so it cannot evict a newer post-bust in-flight entry.
 * Generation maps are bounded (plan §2.3 N-5): an entry is pruned when
 * its settled entry is evicted by the size cap, the maps are hard-capped
 * with oldest-dormant-entry eviction, and resetIdentityCache discards
 * them with the rest of the scope state.
 *
 * Failure semantics (plan §2.4, review C-5 / S2-8): errors are NEVER
 * cached and stale values are NEVER served on error - a loader throw
 * (including RESOURCE_EXHAUSTED) evicts the in-flight entry in the
 * finally step BEFORE any waiter resumes, leaves NO settled entry,
 * and the SAME rejection is delivered to every waiter on the shared
 * promise (an internal no-op rejection branch guards against
 * unhandled rejections). The throw propagates to the caller, whose
 * existing error handling applies. A throwing permission-doc get is
 * NEVER converted into a cached {exists:false}. A successful read of
 * a MISSING doc (exists:false) is data, not an error, and IS cached.
 *
 * Immutability (review C-4 / S2-7): values are copied on store and
 * frozen - the identity bundle, both sub-objects, and any sliced
 * additionalRoles array; permission-doc entry data likewise (shallow
 * copy, array values sliced, then frozen). No caller can mutate a
 * cached value and contaminate later requests; derivations in
 * permissions.ts hand out fresh slices only, never the cached array.
 *
 * Negative caching (review C-6 / S2-10): a cached {exists:false}
 * bundle/doc is invalidated IMMEDIATELY when the missing doc is
 * created by a mapped in-process writer (those writers bust after
 * commit, plan §2.5 - first assignRole W1, governor grant W14,
 * sync-user-role W9, profile merge set W17, definition creates
 * W11/W12); creation by any out-of-band path (client SDK, Cloud
 * Functions, Console, ops scripts, another instance) becomes visible
 * within the TTL (<= 30 s) by expiry alone.
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

/** Hard safety cap on permission-doc entries per scope (plan §2.3 N-5). */
const MAX_PERMISSION_ENTRIES = 1_000;

/** Hard safety cap on generation entries per cache kind, per scope (N-5). */
const MAX_GENERATION_ENTRIES = 1_000;

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

/** An in-flight load plus the generation it captured before starting. */
interface InflightEntry<T> {
  promise: Promise<T>;
  generation: number;
}

interface ScopeState {
  identities: Map<string, IdentityBundle>;
  identityInflight: Map<string, InflightEntry<IdentityBundle>>;
  identityGenerations: Map<string, number>;
  permissionDocs: Map<string, PermissionDocEntry & { loadedAt: number }>;
  permissionInflight: Map<string, InflightEntry<PermissionDocEntry>>;
  permissionGenerations: Map<string, number>;
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
      identityGenerations: new Map(),
      permissionDocs: new Map(),
      permissionInflight: new Map(),
      permissionGenerations: new Map(),
    };
    scopes.set(key, state);
  }
  return state;
}

function allStates(): ScopeState[] {
  return [...scopes.values()];
}

/**
 * Copy-on-store + freeze for identity bundles (C-4): fresh sub-objects,
 * additionalRoles sliced when it is an array (a non-array value is
 * stored as-is - derivations only Array.isArray-test it), then the
 * bundle, both sub-objects, and any sliced array are frozen. The
 * loader's loadedAt stamp is preserved verbatim.
 */
function copyAndFreezeBundle(bundle: IdentityBundle): IdentityBundle {
  const slice = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    const copy = [...value];
    Object.freeze(copy);
    return copy;
  };
  const roles = bundle.roles
    ? { ...bundle.roles, additionalRoles: slice(bundle.roles.additionalRoles) }
    : null;
  if (roles) Object.freeze(roles);
  const users = bundle.users
    ? { ...bundle.users, additionalRoles: slice(bundle.users.additionalRoles) }
    : null;
  if (users) Object.freeze(users);
  const copy: IdentityBundle = { roles, users, loadedAt: bundle.loadedAt };
  Object.freeze(copy);
  return copy;
}

/**
 * Copy-on-store + freeze for permission-doc entry data (C-4): shallow
 * copy with any array values sliced, then the data and the entry are
 * frozen. A missing doc keeps data === undefined.
 */
function copyAndFreezePermissionEntry(entry: PermissionDocEntry): PermissionDocEntry {
  let data: Record<string, unknown> | undefined;
  if (entry.data !== undefined) {
    data = { ...entry.data };
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (Array.isArray(value)) {
        const copy = [...value];
        Object.freeze(copy);
        data[key] = copy;
      }
    }
    Object.freeze(data);
  }
  const copy: PermissionDocEntry = { exists: entry.exists, data };
  Object.freeze(copy);
  return copy;
}

/** Current generation for a key (0 when the key was never seen). */
function generationOf(generations: Map<string, number>, key: string): number {
  return generations.get(key) ?? 0;
}

/**
 * Return the key's generation, creating its entry (value 0) on first
 * sight so a later bust has an entry to increment and a later stale
 * resolve has a value to compare against. Keeps the map within its cap
 * by evicting the oldest dormant entries (a key is dormant when it has
 * no settled and no in-flight entry left to protect).
 */
function ensureGeneration(
  generations: Map<string, number>,
  key: string,
  isDormant: (candidate: string) => boolean,
): number {
  const existing = generations.get(key);
  if (existing !== undefined) return existing;
  generations.set(key, 0);
  while (generations.size > MAX_GENERATION_ENTRIES) {
    let evicted = false;
    for (const candidate of generations.keys()) {
      if (candidate !== key && isDormant(candidate)) {
        generations.delete(candidate);
        evicted = true;
        break;
      }
    }
    if (!evicted) break;
  }
  return 0;
}

/**
 * Increment a key's generation on bust - but only when the key is
 * actually tracked (a settled entry, an in-flight entry, or an existing
 * generation entry from an earlier load). A bust for a never-seen key
 * has nothing to neutralize, and skipping it keeps stray busts from
 * growing the generation map without bound (N-5).
 */
function bumpGeneration(
  generations: Map<string, number>,
  key: string,
  wasTracked: boolean,
): void {
  if (!wasTracked && !generations.has(key)) return;
  generations.set(key, generationOf(generations, key) + 1);
}

/**
 * Load (or reuse) the identity bundle for `uid`. A fresh cached bundle
 * is returned without running `loader`; concurrent loads for the same
 * uid share one loader run. Loader errors propagate and are not cached.
 *
 * Deliberately NOT an `async` function: it returns the in-flight
 * promise object itself, the very promise the internal no-op rejection
 * branch (§2.4 C-5) is attached to. An `async` wrapper would mint a
 * second promise adopting it, and THAT promise would have no branch -
 * a waiter attaching its handler late would surface an unhandled
 * rejection despite the branch (T-A5 late-waiter pin).
 */
export function getIdentityBundle(
  uid: string,
  loader: () => Promise<IdentityBundle>,
  opts: CacheOptions = {},
): Promise<IdentityBundle> {
  const now = opts.now ?? Date.now();
  const state = stateFor(opts.scope);
  const hit = state.identities.get(uid);
  if (hit && now - hit.loadedAt < IDENTITY_TTL_MS) return Promise.resolve(hit);
  const inflight = state.identityInflight.get(uid);
  if (inflight) return inflight.promise;
  // Reaching here with a hit means it is expired. Remember exactly
  // that entry so a failed reload leaves NO settled entry (C-5)
  // without ever clobbering a newer entry stored in the meantime.
  const expiredHit = hit;
  // C-1 step 1: capture the generation BEFORE starting the loader.
  const generation = ensureGeneration(
    state.identityGenerations,
    uid,
    (candidate) => !state.identities.has(candidate) && !state.identityInflight.has(candidate),
  );
  let promise!: Promise<IdentityBundle>;
  promise = (async () => {
    try {
      const bundle = await loader();
      // C-4: copy-on-store + freeze, whether or not the result is
      // stored, so no waiter ever receives the loader's mutable
      // object. The copy preserves the loader's loadedAt stamp.
      const stored = copyAndFreezeBundle(bundle);
      // C-1 step 3: store ONLY if the generation is unchanged - a bust
      // during the load discards this (pre-write) result. The value is
      // still returned to this load's own pre-bust waiters (§2.3).
      if (generationOf(state.identityGenerations, uid) === generation) {
        state.identities.set(uid, stored);
        if (state.identities.size > MAX_IDENTITY_ENTRIES) {
          // Evict the oldest insertion (Map iteration order).
          const oldest = state.identities.keys().next().value;
          if (oldest !== undefined && oldest !== uid) {
            state.identities.delete(oldest);
            // N-5: prune the evicted key's generation once nothing
            // in flight still needs it.
            if (!state.identityInflight.has(oldest)) {
              state.identityGenerations.delete(oldest);
            }
          }
        }
      }
      return stored;
    } catch (err) {
      // C-5: a failed load leaves NO settled entry - drop the expired
      // entry this load was refreshing, but only if it is still the
      // settled entry. The same rejection object is rethrown so every
      // waiter on the shared promise receives it.
      if (expiredHit !== undefined && state.identities.get(uid) === expiredHit) {
        state.identities.delete(uid);
      }
      throw err;
    } finally {
      // S2-4: identity-checked cleanup - only evict the in-flight
      // entry if it is still THIS promise; a bust may already have
      // replaced it with a newer post-bust load.
      const current = state.identityInflight.get(uid);
      if (current && current.promise === promise) {
        state.identityInflight.delete(uid);
      }
    }
  })();
  // Internal no-op rejection branch (§2.4 C-5): a waiter that has
  // already returned must not produce an unhandled rejection; the
  // original promise still delivers the rejection to every waiter.
  void promise.catch(() => undefined);
  state.identityInflight.set(uid, { promise, generation });
  return promise;
}

/**
 * Load (or reuse) one permission doc. Same TTL, same failure semantics
 * as the identity bundle: throws propagate uncached; exists:false is a
 * legitimate cached answer. Same generation protocol (C-1 steps 1-4).
 * Also deliberately NOT `async`, for the same late-waiter reason as
 * getIdentityBundle.
 */
export function getPermissionDoc(
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
    return Promise.resolve({ exists: hit.exists, data: hit.data });
  }
  const inflight = state.permissionInflight.get(key);
  if (inflight) return inflight.promise;
  // As in getIdentityBundle: an expired settled entry is remembered
  // so a failed reload leaves NO settled entry (C-5).
  const expiredHit = hit;
  // C-1 step 1: capture the generation BEFORE starting the loader.
  const generation = ensureGeneration(
    state.permissionGenerations,
    key,
    (candidate) => !state.permissionDocs.has(candidate) && !state.permissionInflight.has(candidate),
  );
  let promise!: Promise<PermissionDocEntry>;
  promise = (async () => {
    try {
      const entry = await loader();
      // C-4: copy-on-store + freeze for the entry data, whether or
      // not the result is stored. A throw above never reaches this
      // point, so a throwing get can never become {exists:false}.
      const stored = copyAndFreezePermissionEntry(entry);
      // C-1 step 3: store ONLY if the generation is unchanged.
      if (generationOf(state.permissionGenerations, key) === generation) {
        // loadedAt is ALWAYS the real Date.now() at store time
        // (C-3 pin, T-A8): the caller-supplied `now` is a comparison
        // clock for tests only and is never stored - a future-dated
        // stored loadedAt would make the entry effectively immortal,
        // a past-dated one instantly stale.
        state.permissionDocs.set(key, { ...stored, loadedAt: Date.now() });
        if (state.permissionDocs.size > MAX_PERMISSION_ENTRIES) {
          // Evict the oldest insertion (Map iteration order).
          const oldest = state.permissionDocs.keys().next().value;
          if (oldest !== undefined && oldest !== key) {
            state.permissionDocs.delete(oldest);
            // N-5: prune the evicted key's generation once nothing
            // in flight still needs it.
            if (!state.permissionInflight.has(oldest)) {
              state.permissionGenerations.delete(oldest);
            }
          }
        }
      }
      return stored;
    } catch (err) {
      // C-5: no settled entry survives a failed load (identity-checked
      // against the expired entry this load was refreshing); the same
      // rejection is rethrown to every waiter.
      if (expiredHit !== undefined && state.permissionDocs.get(key) === expiredHit) {
        state.permissionDocs.delete(key);
      }
      throw err;
    } finally {
      // S2-4: identity-checked cleanup, as in getIdentityBundle.
      const current = state.permissionInflight.get(key);
      if (current && current.promise === promise) {
        state.permissionInflight.delete(key);
      }
    }
  })();
  // Internal no-op rejection branch (§2.4 C-5), as above.
  void promise.catch(() => undefined);
  state.permissionInflight.set(key, { promise, generation });
  return promise;
}

/**
 * Drop one uid's identity entries (settled + in-flight), every scope,
 * AND increment the uid's generation (C-1 step 2), so a load already
 * in flight for this uid can never resurrect the pre-bust bundle.
 */
export function bustIdentity(uid: string): void {
  for (const state of allStates()) {
    const hadSettled = state.identities.delete(uid);
    const hadInflight = state.identityInflight.delete(uid);
    bumpGeneration(state.identityGenerations, uid, hadSettled || hadInflight);
  }
}

/**
 * Drop every identity entry, every scope, and increment every known
 * identity generation, so no in-flight load from before the bust-all
 * can store its result afterwards.
 */
export function bustAllIdentities(): void {
  for (const state of allStates()) {
    state.identities.clear();
    state.identityInflight.clear();
    for (const key of state.identityGenerations.keys()) {
      state.identityGenerations.set(key, generationOf(state.identityGenerations, key) + 1);
    }
  }
}

/**
 * Drop one permission-doc entry (settled + in-flight), every scope,
 * AND increment the key's generation (C-1 step 2), so a load already
 * in flight for this doc can never resurrect the pre-bust entry.
 */
export function bustPermissionDoc(
  collection: 'roleDefinitions' | 'permissions',
  slug: string,
): void {
  const key = `${collection}:${slug}`;
  for (const state of allStates()) {
    const hadSettled = state.permissionDocs.delete(key);
    const hadInflight = state.permissionInflight.delete(key);
    bumpGeneration(state.permissionGenerations, key, hadSettled || hadInflight);
  }
}

/** Test hook, mirroring resetPhase1FlagsCache(). Clears settled,
 * in-flight, and generation state (the whole scope state is dropped). */
export function resetIdentityCache(): void {
  scopes.clear();
}
