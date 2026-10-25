/**
 * @jest-environment node
 *
 * Seam gate for G2 (cron-g2 surface): flag OFF (or another surface, or
 * Supabase unconfigured) -> getG2Db() returns the EXACT object getDb()
 * returns; flag ON for 'cron-g2' -> it returns the shared handle.
 */
const FAKE_FIRESTORE_DB = { __fakeFirestore: true };
const mockState = { handle: null as unknown };

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => FAKE_FIRESTORE_DB),
  getAuth: jest.fn(() => null),
  getApp: jest.fn(() => null),
}));

jest.mock('@/lib/server/supa-db-handle', () => {
  const actual = jest.requireActual('@/lib/server/supa-db-handle');
  return {
    ...actual,
    supaDbHandleFor: (surface: string) =>
      surface === 'cron-g2' ? mockState.handle : null,
  };
});

import { getG2Db, G2_SURFACE } from '../g2-data';

beforeEach(() => {
  mockState.handle = null;
});

describe('g2-data seam gate', () => {
  it('surface name is cron-g2', () => {
    expect(G2_SURFACE).toBe('cron-g2');
  });

  it('flag OFF: returns the exact Firestore db object', () => {
    expect(getG2Db()).toBe(FAKE_FIRESTORE_DB);
  });

  it('flag ON + configured: returns the handle', () => {
    const handle = { __handle: true };
    mockState.handle = handle;
    expect(getG2Db()).toBe(handle);
  });
});
