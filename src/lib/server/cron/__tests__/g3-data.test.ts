/**
 * @jest-environment node
 *
 * Seam gate tests for src/lib/server/cron/g3-data.ts (flag-OFF /
 * flag-ON-but-unconfigured behaviour). Route-level flag-ON behaviour
 * against FakeSupa lives in each route's supa-flag-on test; here we pin
 * that the seam is a no-op unless 'cron-g3' is ON *and* a Supabase
 * client is configured:
 *  - flag unset / other surfaces only -> the exact getDb() result,
 *  - 'cron-g3' ON but no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ->
 *    still the exact getDb() result (Firestore fallback is the gate's
 *    second half, per src/lib/supa/flags.ts).
 * Zero live reads: getDb is mocked, no Supabase env is set.
 */
const mockFirestoreDb = { __sentinel: 'real-firestore-db' };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockFirestoreDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

import { getG3Db } from '../g3-data';

const KEYS = ['SUPA_SURFACES', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env.SUPA_SURFACES;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('getG3Db flag gate', () => {
  it('flag OFF (SUPA_SURFACES unset): returns the real getDb() result untouched', () => {
    expect(getG3Db()).toBe(mockFirestoreDb);
  });

  it('flag OFF for this surface (other surfaces ON): returns the real getDb() result', () => {
    process.env.SUPA_SURFACES = 'cron-g1,cron-g2,announcements';
    expect(getG3Db()).toBe(mockFirestoreDb);
  });

  it("flag ON ('cron-g3') but Supabase unconfigured: falls back to the real getDb() result", () => {
    process.env.SUPA_SURFACES = 'cron-g3';
    expect(getG3Db()).toBe(mockFirestoreDb);
  });
});
