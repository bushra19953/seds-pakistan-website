/**
 * Audit item 10 (b)+(c): cron shared-secret comparisons must be
 * timing-safe and fail closed, including the elections-lifecycle
 * empty-string edge: CRON_SECRET set to '' must never authenticate,
 * even against a bare "Bearer " header.
 */
import { isCronRequest } from '../cron-auth';

const SECRET = 'test-cron-secret-value';

describe('isCronRequest', () => {
  it('accepts the exact Bearer secret', () => {
    expect(isCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects wrong, truncated, extended and scheme-less values', () => {
    expect(isCronRequest('Bearer wrong-secret-value', SECRET)).toBe(false);
    expect(isCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isCronRequest(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isCronRequest(SECRET, SECRET)).toBe(false);
    expect(isCronRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it('fails closed when the secret is unset or empty (item 10c edge)', () => {
    expect(isCronRequest(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(isCronRequest('Bearer ', '')).toBe(false);
    expect(isCronRequest('Bearer ', undefined)).toBe(false);
    expect(isCronRequest('', '')).toBe(false);
  });

  it('fails closed on a missing header', () => {
    expect(isCronRequest(null, SECRET)).toBe(false);
    expect(isCronRequest(undefined, SECRET)).toBe(false);
    expect(isCronRequest('', SECRET)).toBe(false);
  });

  it('defaults the expected secret to the CRON_SECRET env var', () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    try {
      expect(isCronRequest(`Bearer ${SECRET}`)).toBe(true);
      expect(isCronRequest('Bearer nope-nope-nope')).toBe(false);
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });
});
