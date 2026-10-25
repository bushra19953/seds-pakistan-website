/**
 * @jest-environment node
 *
 * Seam gate for G4 (backup + admin exports, surface 'backup-exports'):
 *  - flag OFF (or surface not enabled, or Supabase unconfigured):
 *    getG4Db() returns EXACTLY what getDb() returns and getG4Handle()
 *    is null, so flag-off behavior is byte-identical to today;
 *  - flag ON + configured: getG4Db() IS the shared handle;
 *  - rehydratePartnerTimestamps: ISO strings in the rendered fields
 *    (createdAt/updatedAt + interactionHistory[].timestamp) become
 *    Timestamp-like objects carrying the same instant; dumped-shape
 *    timestamps and all other fields pass through untouched.
 */
import { SupaTimestamp } from '@/lib/supa/adapter';

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
      surface === 'backup-exports' ? mockState.handle : null,
  };
});

import {
  getG4Db,
  getG4Handle,
  rehydratePartnerTimestamps,
} from '../g4-data';

beforeEach(() => {
  mockState.handle = null;
});

describe('g4-data seam gate', () => {
  it('flag OFF: getG4Db() is exactly the Firestore db, handle is null', () => {
    expect(getG4Handle()).toBeNull();
    expect(getG4Db()).toBe(FAKE_FIRESTORE_DB);
  });

  it('flag ON + configured: getG4Db() IS the handle', () => {
    const handle = { __handle: true };
    mockState.handle = handle;
    expect(getG4Handle()).toBe(handle);
    expect(getG4Db()).toBe(handle);
  });
});

describe('rehydratePartnerTimestamps', () => {
  it('rehydrates ISO strings in the rendered fields only', () => {
    const iso = '2026-02-03T04:05:06.789Z';
    const dumped = { _seconds: 1760000000, _nanoseconds: 123000000 };
    const out = rehydratePartnerTimestamps({
      organizationName: 'Org',
      createdAt: iso,
      updatedAt: dumped,
      agreementDate: '2026-01-01',
      interactionHistory: [
        { timestamp: iso, author: 'A', note: 'met' },
        { timestamp: dumped, author: 'B', note: 'called' },
        'legacy-string-entry',
      ],
    });
    const created = out.createdAt as unknown as SupaTimestamp;
    expect(created).toBeInstanceOf(SupaTimestamp);
    expect(created.toDate().toISOString()).toBe(iso);
    // Dumped shapes pass through untouched (same reference).
    expect(out.updatedAt).toBe(dumped);
    const history = out.interactionHistory as Array<Record<string, unknown>>;
    expect(
      (history[0].timestamp as unknown as SupaTimestamp)
        .toDate()
        .toISOString(),
    ).toBe(iso);
    expect(history[1].timestamp).toBe(dumped);
    expect(history[2]).toBe('legacy-string-entry');
    // Non-rendered string fields are NOT converted.
    expect(out.agreementDate).toBe('2026-01-01');
    expect(out.organizationName).toBe('Org');
  });
});
