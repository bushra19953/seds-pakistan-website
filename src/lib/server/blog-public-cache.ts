/**
 * In-process cache + last-good shelter for the PUBLIC blog read
 * routes — GET /api/blogs (list), GET /api/blogs/[slug] (post),
 * GET /api/blogs/latest (homepage strip). Wave-2 perf program,
 * 2026-10-30 (founder order: fix the website's performance).
 *
 * THE PROBLEM (wave-1 vitals baseline): /api/blogs answered with
 * ~3.2 s TTFB, uncached at the origin, and was named the Blog LCP
 * driver (blog index LCP 2.94 s, post pages worse). The routes'
 * `s-maxage` Cache-Control headers never helped origin latency:
 * Render free has no shared cache in front (the warning-registry
 * lesson), so EVERY visitor's request re-ran the full read path —
 * a Supabase list leg (up to 150 rows, whole post bodies included)
 * or a Firestore query, with an in-memory filter/sort on top.
 *
 * THE PATTERN (copied in shape, not code, from the two proven
 * house treatments):
 *  - src/app/api/public/hierarchy — an in-process TTL payload
 *    cache so repeat public views do not re-bill the read set;
 *  - src/app/api/public/mission-board (wave-1 agent 10) — the same
 *    TTL cache PLUS in-flight dedupe, PLUS the shared last-good
 *    shelter (src/lib/server/public-stale-cache.ts): a success is
 *    remembered, a backend failure serves the last-good body with
 *    `X-Served-Stale: last-good`, and with no last-good the failure
 *    stays the loud error it was.
 *
 * CONTRACT:
 *  - Payloads are byte-identical: what is cached is the inner
 *    handler's own serialized JSON body, re-served verbatim, and
 *    fresh responses (miss or hit) carry the route's existing
 *    Cache-Control header unchanged. Stale serves carry
 *    PUBLIC_STALE_CACHE_CONTROL + the X-Served-Stale marker —
 *    the mission-board stale branch, word for word.
 *  - Errors are NEVER cached and never stored as last-good: a
 *    failure with no last-good returns the handler's own error
 *    response untouched, and recovery is visible on the next
 *    request.
 *  - A DEFINITIVE 404 (unknown slug; a post that is no longer
 *    public) is never cached and FORGETS the key's last-good
 *    entry, so a later backend failure cannot resurrect an
 *    unpublished or deleted post.
 *  - Cache keys are the route's own distinguishing params
 *    (limit/category/author/search/cursor for the list, the slug
 *    for a post, the limit for latest) — the public-stale-cache
 *    key discipline.
 *
 * INVALIDATION: every in-app write path — POST /api/blogs,
 * POST /api/admin/blogs, PUT + DELETE /api/admin/blogs/[id] —
 * calls invalidateBlogPublicCache() synchronously after its
 * write lands, so admin acts are visible on the very next public
 * read (the chapters-cache doctrine). The 120 s TTL therefore
 * only bounds OUT-OF-BAND edits (Firebase console, direct
 * client-SDK writers); 120 s matches the warning-registry TTL
 * doctrine and is invisible against blog publishing cadence.
 *
 * TEST POSTURE: inert under NODE_ENV=test unless a suite opts in
 * via __enableBlogPublicCacheForTests() (the hierarchy
 * precedent: its payload cache is bypassed under test so the
 * pre-existing suites, which call the handlers repeatedly with
 * different fixtures, stay deterministic). The blog family has
 * nine such suites; none of them is edited by this change.
 */

import { NextResponse } from 'next/server';
import {
  PUBLIC_STALE_CACHE_CONTROL,
  forgetLastGoodPublic,
  getLastGoodPublic,
  rememberLastGoodPublic,
} from './public-stale-cache';

export const BLOG_PUBLIC_CACHE_TTL_MS = 120 * 1000;

const STALE_PREFIX = 'public/blogs:';

interface FreshEntry {
  expiresAt: number;
  body: unknown;
}

interface LoadOutcome {
  status: number;
  body: unknown;
  generation: number;
}

const freshEntries = new Map<string, FreshEntry>();
const inFlight = new Map<string, Promise<LoadOutcome>>();
const lastGoodKeys = new Set<string>();
let generation = 0;
let testOptIn = false;

function cacheActive(): boolean {
  return process.env.NODE_ENV !== 'test' || testOptIn;
}

export function blogListCacheKey(q: {
  limit: number;
  category?: string | null;
  author?: string | null;
  search?: string | null;
  cursor?: string | null;
}): string {
  return [
    'list',
    q.limit,
    q.category ?? '',
    q.author ?? '',
    q.search ?? '',
    q.cursor ?? '',
  ].join('|');
}

export function blogPostCacheKey(slug: string): string {
  return `post|${slug}`;
}

export function blogLatestCacheKey(limit: number): string {
  return `latest|${limit}`;
}

function respond(
  body: unknown,
  status: number,
  cacheControl?: string,
  stale = false,
): NextResponse {
  const headers: Record<string, string> = {};
  if (stale) {
    headers['Cache-Control'] = PUBLIC_STALE_CACHE_CONTROL;
    headers['X-Served-Stale'] = 'last-good';
  } else if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  return NextResponse.json(body, { status, headers });
}

/**
 * Serve one public blog read through the cache. `produce` is the
 * route's existing handler, unchanged; it must convert its own
 * failures into responses (all three blog GET handlers do).
 */
export async function serveBlogPublic(
  key: string,
  cacheControl: string,
  produce: () => Promise<NextResponse>,
): Promise<NextResponse> {
  if (!cacheActive()) return produce();

  const hit = freshEntries.get(key);
  if (hit && Date.now() <= hit.expiresAt) {
    return respond(hit.body, 200, cacheControl);
  }

  let flight = inFlight.get(key);
  if (!flight) {
    const gen = generation;
    flight = (async (): Promise<LoadOutcome> => {
      const res = await produce();
      let body: unknown = null;
      try {
        body = await res.clone().json();
      } catch {
        body = null;
      }
      return { status: res.status, body, generation: gen };
    })();
    inFlight.set(key, flight);
  }

  try {
    const outcome = await flight;
    if (outcome.status === 200 && outcome.body !== null) {
      // A load that started before a write must not re-cache its
      // pre-write body after the write's invalidation.
      if (outcome.generation === generation) {
        freshEntries.set(key, {
          expiresAt: Date.now() + BLOG_PUBLIC_CACHE_TTL_MS,
          body: outcome.body,
        });
        const staleKey = STALE_PREFIX + key;
        rememberLastGoodPublic(staleKey, outcome.body);
        lastGoodKeys.add(staleKey);
      }
      return respond(outcome.body, 200, cacheControl);
    }
    if (outcome.status === 404) {
      // Definitive negative: never cached, and the last-good goes
      // with it — see the contract in the header.
      freshEntries.delete(key);
      const staleKey = STALE_PREFIX + key;
      forgetLastGoodPublic(staleKey);
      lastGoodKeys.delete(staleKey);
      return respond(outcome.body, 404);
    }
    // Failure: serve the last-good if one exists, else the
    // handler's own loud error, untouched.
    const stale = getLastGoodPublic(STALE_PREFIX + key);
    if (stale !== undefined) {
      console.error(
        `[blog-public-cache] read failed for ${key}; serving last-good body`,
      );
      return respond(stale, 200, undefined, true);
    }
    return respond(outcome.body, outcome.status);
  } finally {
    if (inFlight.get(key) === flight) inFlight.delete(key);
  }
}

/**
 * Bust every public blog cache entry (fresh TTL entries, in-flight
 * legs' right to store, and remembered last-good bodies). Called
 * synchronously by the blog write paths after a successful write.
 */
export function invalidateBlogPublicCache(): void {
  generation += 1;
  freshEntries.clear();
  inFlight.clear();
  for (const key of lastGoodKeys) forgetLastGoodPublic(key);
  lastGoodKeys.clear();
}

/** Test hook: opt this suite into the cache under NODE_ENV=test. */
export function __enableBlogPublicCacheForTests(): void {
  testOptIn = true;
}

/**
 * Test hook: clears the fresh TTL entries + in-flight legs. The
 * last-good shelter is NOT cleared (it lives in public-stale-cache;
 * use its resetPublicStaleCache) — resetting only the fresh layer
 * is how a suite expires the TTL while keeping the shelter.
 */
export function __resetBlogPublicCacheForTests(): void {
  freshEntries.clear();
  inFlight.clear();
}
