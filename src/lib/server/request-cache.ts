/**
 * request-cache.ts — request-scoped memoization for hot server reads
 * (consents seam program, 2026-10-30; census 15 row G3).
 *
 * WHY: the consent gate fans out small, slowly-changing reads on EVERY
 * consent-gated write platform-wide — roleDefinitions/{key} (consent-
 * gate.ts isCategoryBRole) and settings/consent_config (consent-
 * config.ts getConsentConfig) were re-read from Firestore on every
 * gated call, several times within a single request when a route both
 * probes a role's category and then runs the gate. Train 2's interim
 * fix for the same burn (wt-rbt2-doublepay's role-definitions-cache.ts,
 * a 60 s module-level TTL cache over the roles seam) collapses the
 * reads but can serve a definition up to a minute stale; this module
 * is the request-scoped version: within one request scope a key is
 * loaded AT MOST ONCE, and nothing survives the scope, so a config
 * flip takes effect on the next request exactly as the uncached reads
 * behaved. REBASE POINT: when Train 2 lands, its role-definitions-
 * cache reader can be layered UNDER this memo (the memo dedupes per
 * request; the TTL cache dedupes across requests) — the two are
 * complementary, not competing.
 *
 * MECHANISM: an AsyncLocalStorage<Map> (the same scoping primitive
 * src/lib/server/cron/compliance-db-context.ts uses for its db
 * override). Entry points open a scope with runWithRequestCache();
 * nested scopes reuse the outer store. Loads are stored as promises,
 * so concurrent callers share one in-flight read. A rejected load is
 * evicted immediately: a failed read is never memoized, and the error
 * propagates to every waiter exactly as the uncached read behaved.
 *
 * UNSCOPED CALLERS: most gate call sites do not open a scope (the
 * gate's consumers are dozens of routes). When no scope is active,
 * requestCached still dedupes CONCURRENT loads per (owner, key):
 * the in-flight promise is shared and evicted the moment it
 * settles, so a settled value is never served to a later call —
 * sequential calls re-read, exactly as the uncached code behaved
 * (the retention seam's pinned per-call parity contract for
 * getConsentConfig is preserved). There is deliberately NO
 * time-based fallback window: the getDb() handle is a process
 * singleton, so any TTL would silently share values across
 * requests. Callers pass their db handle as `owner`; without an
 * owner the loader runs directly. The governance gate MODE
 * (governance_settings/phase2, getConsentMatterSettings) is
 * deliberately NEVER memoized here: spec B.8 requires a mode flip to
 * take effect on the next attempted act, and that reader keeps its
 * own documented no-cache contract.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type CacheStore = Map<string, Promise<unknown>>;

const storage = new AsyncLocalStorage<CacheStore>();

const fallbackStores = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Run `fn` inside a request-cache scope. If a scope is already active
 * the existing store is reused (scopes nest by sharing, never by
 * shadowing), so an entry point wrapping its body is safe to call
 * from another wrapped entry point.
 */
export function runWithRequestCache<T>(fn: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return fn();
  return storage.run(new Map(), fn);
}

/** True when a request-cache scope is active (test/diagnostic aid). */
export function requestCacheActive(): boolean {
  return storage.getStore() !== undefined;
}

function fallbackStoreFor(owner: object): Map<string, Promise<unknown>> {
  let store = fallbackStores.get(owner);
  if (!store) {
    store = new Map();
    fallbackStores.set(owner, store);
  }
  return store;
}

/**
 * Memoized load: at most one `loader()` run per (scope, key); unscoped,
 * concurrent loads per (owner, key) share one in-flight promise that
 * is evicted on settle. Rejections are evicted in both modes and
 * propagate to all waiters.
 */
export function requestCached<T>(
  key: string,
  loader: () => Promise<T>,
  owner?: object | null,
): Promise<T> {
  const scoped = storage.getStore();
  if (scoped) {
    const hit = scoped.get(key);
    if (hit) return hit as Promise<T>;
    const promise = loader();
    scoped.set(key, promise);
    promise.catch(() => {
      if (scoped.get(key) === promise) scoped.delete(key);
    });
    return promise;
  }

  if (owner) {
    const store = fallbackStoreFor(owner);
    const inFlight = store.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const promise = loader();
    store.set(key, promise);
    const evict = () => {
      if (store.get(key) === promise) store.delete(key);
    };
    promise.then(evict, evict);
    return promise;
  }

  return loader();
}

/** Test hook: drop every unscoped fallback entry for one owner. */
export function __clearRequestCacheFallbackForTests(owner: object): void {
  fallbackStores.delete(owner);
}
