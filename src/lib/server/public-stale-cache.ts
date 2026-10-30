/**
 * Last-good stale-serving for public, slow-changing API routes
 * (founder-shelter program, 2026-10-30 quota outage follow-up).
 *
 * The site-state / warning-registry treatment: a successful response
 * carries `s-maxage + stale-while-revalidate` so shared caches can
 * keep serving it, AND the route remembers its last-good body
 * in-process so a Firestore failure (RESOURCE_EXHAUSTED during a
 * quota death, when the CDN copy may also have aged out) answers
 * 200 with the last-good body + an `X-Served-Stale: last-good`
 * marker instead of a 500 - for content that is public and changes
 * slowly enough that minutes-to-hours-old is harmless.
 *
 * Only routes whose payload is (a) public, (b) not auth-gated,
 * (c) not money-adjacent, and (d) not a per-person privacy decision
 * may use this. Call sites are responsible for their own key choice
 * (route + distinguishing query params). The in-process store has no
 * TTL of its own: it is bounded by process lifetime, and the
 * Cache-Control header bounds how long DOWNSTREAM caches may treat
 * the body as fresh/stale. Entries are keyed per route+params and
 * hard-capped with oldest-first eviction.
 */

export const PUBLIC_STALE_CACHE_CONTROL =
  'public, s-maxage=300, stale-while-revalidate=3600';

const MAX_PUBLIC_STALE_ENTRIES = 500;

interface PublicStaleEntry {
  body: unknown;
  storedAt: number;
}

const entries = new Map<string, PublicStaleEntry>();

/** Remember a route's successful response body under `key`. */
export function rememberLastGoodPublic(
  key: string,
  body: unknown,
  now: number = Date.now(),
): void {
  entries.delete(key);
  entries.set(key, { body, storedAt: now });
  if (entries.size > MAX_PUBLIC_STALE_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined && oldest !== key) entries.delete(oldest);
  }
}

/** The last-good body stored under `key`, or undefined if none. */
export function getLastGoodPublic<T = unknown>(key: string): T | undefined {
  const entry = entries.get(key);
  return entry ? (entry.body as T) : undefined;
}

/**
 * Remove one last-good entry. For callers whose reads can end in a
 * DEFINITIVE negative (a blog post that now 404s because it was
 * unpublished or deleted): serving that body later, during a backend
 * failure, would resurrect content the platform has withdrawn.
 */
export function forgetLastGoodPublic(key: string): void {
  entries.delete(key);
}

/** Test hook. */
export function resetPublicStaleCache(): void {
  entries.clear();
}
