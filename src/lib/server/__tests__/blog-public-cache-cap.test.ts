/**
 * @jest-environment node
 *
 * PERF BATCH-3 CAP FIX — the blog public cache's fresh layer must be
 * BOUNDED, not just TTL'd (lead review, 2026-11-01).
 *
 * As merged from wave-2, blog-public-cache held fresh entries in a
 * Map with a 120 s TTL and no size cap, while its keys are
 * request-controlled (list search/cursor params, post slugs): key
 * spray could grow the Map without bound inside the TTL window —
 * the unbounded in-memory cache class behind the Oct-31 production
 * crash-loop. This suite pins the fix through the public API:
 * after MAX+5 distinct keys are stored, the oldest keys have been
 * evicted (a re-serve re-runs the producer) while the newest keys
 * are still cache hits (producer not re-run).
 */
import { NextResponse } from 'next/server';
import {
  BLOG_PUBLIC_CACHE_MAX_ENTRIES,
  __enableBlogPublicCacheForTests,
  __resetBlogPublicCacheForTests,
  serveBlogPublic,
} from '../blog-public-cache';
import { resetPublicStaleCache } from '../public-stale-cache';

describe('blog public cache fresh layer is capped', () => {
  const calls = new Map<string, number>();

  function produceFor(key: string) {
    return async () => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return NextResponse.json({ key });
    };
  }

  beforeAll(() => {
    __enableBlogPublicCacheForTests();
  });

  beforeEach(() => {
    calls.clear();
    __resetBlogPublicCacheForTests();
    resetPublicStaleCache();
  });

  it('declares a hard cap of 500 entries alongside the TTL', () => {
    expect(BLOG_PUBLIC_CACHE_MAX_ENTRIES).toBe(500);
  });

  it('evicts oldest-first once the cap is exceeded', async () => {
    const total = BLOG_PUBLIC_CACHE_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i++) {
      const key = `post|cap-${i}`;
      await serveBlogPublic(key, 's-maxage=600', produceFor(key));
    }

    // Oldest key was evicted: serving it again re-runs the producer.
    const oldestKey = 'post|cap-0';
    await serveBlogPublic(oldestKey, 's-maxage=600', produceFor(oldestKey));
    expect(calls.get(oldestKey)).toBe(2);

    // Newest key survived: serving it again is a hit.
    const newestKey = `post|cap-${total - 1}`;
    await serveBlogPublic(newestKey, 's-maxage=600', produceFor(newestKey));
    expect(calls.get(newestKey)).toBe(1);
  });
});
