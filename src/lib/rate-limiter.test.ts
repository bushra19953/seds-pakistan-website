/**
 * @jest-environment node
 *
 * Heap-guard tests for src/lib/rate-limiter.ts (fix/heap-root-hunt):
 * the request-count map used to grow without bound. These tests prove the
 * cap: once MAX_RATE_LIMIT_ENTRIES is reached, the oldest entries are
 * evicted, re-checking an existing key never grows the map, and ordinary
 * window/max behaviour is unchanged.
 */
import { RateLimiter } from './rate-limiter';

describe('RateLimiter heap guard', () => {
  it('evicts the oldest entries once the cap is reached', async () => {
    const limiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 1000, keyPrefix: 'cap-test' });
    const TOTAL = 10001; // one more than MAX_RATE_LIMIT_ENTRIES (10000)
    for (let i = 0; i < TOTAL; i++) {
      await limiter.check(`user-${i}`);
    }
    // The very first identifier was evicted to make room.
    expect(limiter.getStatus('user-0')).toBeNull();
    // The most recent identifiers are still tracked.
    expect(limiter.getStatus(`user-${TOTAL - 1}`)).not.toBeNull();
    expect(limiter.getStatus(`user-${TOTAL - 1}`)?.totalRequests).toBe(1);
  });

  it('re-checking an existing key does not evict other keys', async () => {
    const limiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 1000, keyPrefix: 'nogrow-test' });
    for (let i = 0; i < 10000; i++) {
      await limiter.check(`k-${i}`);
    }
    // Re-checking the first key overwrites it in place; nothing is evicted.
    for (let i = 0; i < 5; i++) {
      await limiter.check('k-0');
    }
    expect(limiter.getStatus('k-0')).not.toBeNull();
    expect(limiter.getStatus('k-9999')).not.toBeNull();
  });

  it('still enforces window and maxRequests', async () => {
    const limiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 2, keyPrefix: 'limit-test' });
    expect((await limiter.check('alice')).success).toBe(true);
    expect((await limiter.check('alice')).success).toBe(true);
    const third = await limiter.check('alice');
    expect(third.success).toBe(false);
    expect(third.remaining).toBe(0);
    limiter.reset('alice');
    expect(limiter.getStatus('alice')).toBeNull();
  });
});
