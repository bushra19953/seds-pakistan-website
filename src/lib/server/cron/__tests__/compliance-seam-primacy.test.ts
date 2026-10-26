/**
 * @jest-environment node
 *
 * Cutover contracts for the compliance seam + cron write primacy:
 *  - the ALS acquisition context defaults to null (today's
 *    self-acquisition) and restores after run/throw;
 *  - getComplianceDb: null when 'cron-g2' is OFF, the handle when ON,
 *    and a LOUD CronPrimaryUnavailableError under
 *    isSupaPrimary('cron-g2') with no handle (no silent Firestore
 *    fallback);
 *  - the G1/G2/G3 seam getters throw the same loud error under their
 *    surface's primacy with no handle, and return the Firestore db
 *    byte-identically when primacy is off;
 *  - getElectionsLifecycleDb: real Firestore db under
 *    isSupaPrimary('elections') (reconciliation), the G2 handle
 *    otherwise.
 * Zero live reads; env flags are set per-test and restored.
 */

const mockState = {
  handle: null as unknown,
  firestoreDb: { __firestore: true } as unknown,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockState.firestoreDb),
  getAuth: jest.fn(() => null),
  getApp: jest.fn(() => null),
}));

jest.mock('@/lib/server/supa-db-handle', () => {
  const actual = jest.requireActual('@/lib/server/supa-db-handle');
  return {
    ...actual,
    supaDbHandleFor: () => mockState.handle,
  };
});

import {
  currentComplianceDb,
  runWithComplianceDb,
} from '../compliance-db-context';
import { getComplianceDb } from '../compliance-data';
import { CronPrimaryUnavailableError } from '../cron-primacy';
import { getG2Db, getElectionsLifecycleDb } from '../g2-data';
import { getG3Db } from '../g3-data';
import { getCronG1Db } from '../g1-data';

const ENV_KEYS = ['SUPA_SURFACES', 'SUPA_PRIMARY'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  mockState.handle = null;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('compliance db context (ALS seam)', () => {
  it('defaults to null outside a run (today\u2019s self-acquisition)', () => {
    expect(currentComplianceDb()).toBeNull();
  });

  it('exposes the db inside runWithComplianceDb and restores after', async () => {
    const db = { __seam: true };
    const seen = await runWithComplianceDb(db, async () => currentComplianceDb());
    expect(seen).toBe(db);
    expect(currentComplianceDb()).toBeNull();
  });

  it('restores after a throw', async () => {
    await expect(
      runWithComplianceDb({ __seam: true }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(currentComplianceDb()).toBeNull();
  });
});

describe('getComplianceDb primacy law', () => {
  it('OFF: returns null (routes run unwrapped, byte-identical)', () => {
    expect(getComplianceDb()).toBeNull();
  });

  it('SURFACES on + handle: returns the handle', () => {
    process.env.SUPA_SURFACES = 'cron-g2';
    mockState.handle = { __handle: true };
    expect(getComplianceDb()).toBe(mockState.handle);
  });

  it('SURFACES on, no handle, PRIMARY off: returns null (existing fallback)', () => {
    process.env.SUPA_SURFACES = 'cron-g2';
    expect(getComplianceDb()).toBeNull();
  });

  it('PRIMARY on (both flags) + no handle: throws loudly', () => {
    process.env.SUPA_SURFACES = 'cron-g2';
    process.env.SUPA_PRIMARY = 'cron-g2';
    expect(() => getComplianceDb()).toThrow(CronPrimaryUnavailableError);
  });

  it('PRIMARY token alone (SURFACES off): no throw, returns null (flag law)', () => {
    process.env.SUPA_PRIMARY = 'cron-g2';
    expect(getComplianceDb()).toBeNull();
  });
});

describe('cron seam getters under primacy', () => {
  it.each([
    ['cron-g1', () => getCronG1Db()],
    ['cron-g2', () => getG2Db()],
    ['cron-g3', () => getG3Db()],
  ])('%s: primacy + no handle throws', (surface, get) => {
    process.env.SUPA_SURFACES = surface;
    process.env.SUPA_PRIMARY = surface;
    expect(get).toThrow(CronPrimaryUnavailableError);
  });

  it.each([
    ['cron-g1', () => getCronG1Db()],
    ['cron-g2', () => getG2Db()],
    ['cron-g3', () => getG3Db()],
  ])('%s: primacy OFF returns the Firestore db', (_surface, get) => {
    expect(get()).toBe(mockState.firestoreDb);
  });
});

describe('getElectionsLifecycleDb reconciliation', () => {
  it('elections primacy: returns the real Firestore db even when a cron-g2 handle exists', () => {
    process.env.SUPA_SURFACES = 'elections,cron-g2';
    process.env.SUPA_PRIMARY = 'elections';
    mockState.handle = { __handle: true };
    expect(getElectionsLifecycleDb()).toBe(mockState.firestoreDb);
  });

  it('no elections primacy: returns the G2 handle (pinned flag-on behaviour)', () => {
    process.env.SUPA_SURFACES = 'cron-g2';
    mockState.handle = { __handle: true };
    expect(getElectionsLifecycleDb()).toBe(mockState.handle);
  });

  it('all flags off: returns the Firestore db', () => {
    expect(getElectionsLifecycleDb()).toBe(mockState.firestoreDb);
  });
});
