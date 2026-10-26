/**
 * @jest-environment node
 *
 * Cutover wiring contracts for the residual compliance consumers:
 *  - getConsentConfig (the consent-gate reader): reads
 *    settings/consent_config through retentionConsentData when the
 *    'erasure-consent' surface is enabled — a doc narrows the
 *    defaults, a missing doc yields defaults, an adapter error
 *    yields defaults (the same outcomes the Firestore paths
 *    produce); flag OFF never consults the seam.
 *  - createErasureDepsForLifecycle: Firestore deps when OFF, the
 *    plan-G3 Supa facade deps when ON (and the facade refuses every
 *    collection except erasure_requests — the execute path can
 *    never run on it).
 */

const seamState = {
  enabled: false,
  raw: null as Record<string, unknown> | null,
  rawError: null as Error | null,
};

jest.mock('@/lib/retention/supa-seam', () => {
  const actual = jest.requireActual('@/lib/retention/supa-seam');
  return {
    ...actual,
    retentionConsentData: {
      ...actual.retentionConsentData,
      enabled: () => seamState.enabled,
      getConsentConfigRaw: async () => {
        if (seamState.rawError) throw seamState.rawError;
        return seamState.raw;
      },
    },
    retentionSupaEnabled: () => seamState.enabled,
  };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: { auth: () => ({ deleteUser: async () => undefined }) },
  getDb: () => ({
    collection: () => ({
      add: async () => ({ id: 'audit-1' }),
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    }),
  }),
}));

import { getConsentConfig, DEFAULT_CONSENT_CONFIG } from '@/lib/consents/consent-config';
import { createErasureDepsForLifecycle } from '@/lib/retention/server-deps';
import { createSupaErasureDb } from '@/lib/retention/supa-seam';

const fakeDb: any = {
  collection: () => ({
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({ filingsEnabled: false, founderRootMode: 'founder_only' }),
      }),
    }),
  }),
};

beforeEach(() => {
  seamState.enabled = false;
  seamState.raw = null;
  seamState.rawError = null;
});

describe('getConsentConfig seam wiring (consent-gate reader)', () => {
  it('OFF: Firestore read serves (seam untouched)', async () => {
    const cfg = await getConsentConfig(fakeDb);
    expect(cfg).toEqual({ filingsEnabled: false, founderRootMode: 'founder_only' });
  });

  it('ON + doc present: seam doc narrows the defaults', async () => {
    seamState.enabled = true;
    seamState.raw = { filingsEnabled: false, founderRootMode: 'founder_or_cto_under_consent' };
    const cfg = await getConsentConfig(fakeDb);
    expect(cfg).toEqual({
      filingsEnabled: false,
      founderRootMode: 'founder_or_cto_under_consent',
    });
  });

  it('ON + doc missing: defaults (classification parity with Firestore-missing)', async () => {
    seamState.enabled = true;
    seamState.raw = null;
    expect(await getConsentConfig(fakeDb)).toEqual({ ...DEFAULT_CONSENT_CONFIG });
  });

  it('ON + adapter error: defaults (parity with the Firestore-error catch)', async () => {
    seamState.enabled = true;
    seamState.rawError = new Error('adapter down');
    expect(await getConsentConfig(fakeDb)).toEqual({ ...DEFAULT_CONSENT_CONFIG });
  });
});

describe('erasure lifecycle deps selector', () => {
  it('OFF: Firestore deps (db is the production fake, not the facade)', () => {
    const deps = createErasureDepsForLifecycle();
    expect(typeof deps.deleteAuthUser).toBe('function');
    // The Firestore deps' db has no facade guard; calling a foreign
    // collection must NOT throw the facade's refusal.
    expect(() => deps.db.collection('users')).not.toThrow(
      /serves erasure_requests only/,
    );
  });

  it('ON: facade deps — erasure_requests served, execute-path collections refused', () => {
    seamState.enabled = true;
    const deps = createErasureDepsForLifecycle();
    expect(() => deps.db.collection('erasure_requests')).not.toThrow();
    expect(() => deps.db.collection('users')).toThrow(
      /serves erasure_requests only/,
    );
  });

  it('the facade itself refuses foreign collections (G3-2)', () => {
    const db = createSupaErasureDb();
    expect(() => db.collection('points_ledger')).toThrow(
      /serves erasure_requests only/,
    );
  });
});
