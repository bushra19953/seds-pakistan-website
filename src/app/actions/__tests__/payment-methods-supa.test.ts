/**
 * @jest-environment node
 *
 * Group 4: getPaymentMethodsSettings server action.
 * Flag ON serves settings/payment_methods from fs_settings raw (the
 * snap.data() shape, id stripped, approval-stamped destinationMeta
 * tolerated); OFF / unconfigured / adapter error falls back to the
 * server-side Firestore read; missing doc -> null on both paths.
 */

const mockState = {
  flagOn: false,
  clientPresent: true,
  adapterFails: false,
  supaDoc: null as Record<string, any> | null,
  fsDoc: null as Record<string, any> | null,
  adapterCalls: 0,
};

const mockDb = {
  collection: (name: string) => {
    if (name !== 'settings') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => ({
        get: async () => ({
          exists: id === 'payment_methods' && !!mockState.fsDoc,
          data: () => (mockState.fsDoc ? { ...mockState.fsDoc } : undefined),
        }),
      }),
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(async () => mockDb),
}));

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => mockState.flagOn),
  getSupaClient: jest.fn(() => (mockState.clientPresent ? {} : null)),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (collection: string, id: string) => {
      mockState.adapterCalls++;
      expect(collection).toBe('settings');
      expect(id).toBe('payment_methods');
      if (mockState.adapterFails) throw new Error('adapter boom');
      return mockState.supaDoc ? { id: 'payment_methods', ...mockState.supaDoc } : null;
    }),
  })),
}));

import { getPaymentMethodsSettings } from '@/app/actions/payment-methods';

const fsSettings = {
  methods: { bank_transfer: { enabled: true, label: 'Bank' } },
  order: ['bank_transfer'],
  testMode: false,
};
const supaSettings = {
  methods: { easypaisa: { enabled: true, label: 'Easypaisa' } },
  order: ['easypaisa'],
  testMode: true,
  destinationMeta: { approvedBy: 'finance-1', requestId: 'req-9' },
};

beforeEach(() => {
  mockState.flagOn = false;
  mockState.clientPresent = true;
  mockState.adapterFails = false;
  mockState.supaDoc = null;
  mockState.fsDoc = fsSettings;
  mockState.adapterCalls = 0;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('getPaymentMethodsSettings', () => {
  it('flag OFF: Firestore doc data, adapter never called', async () => {
    await expect(getPaymentMethodsSettings()).resolves.toEqual(fsSettings);
    expect(mockState.adapterCalls).toBe(0);
  });

  it('flag OFF + missing doc -> null', async () => {
    mockState.fsDoc = null;
    await expect(getPaymentMethodsSettings()).resolves.toBeNull();
  });

  it('flag ON: raw adapter body (id stripped, destinationMeta passes through)', async () => {
    mockState.flagOn = true; mockState.supaDoc = supaSettings;
    const data = await getPaymentMethodsSettings();
    expect(data).toEqual(supaSettings);
    expect((data as any).id).toBeUndefined();
  });

  it('flag ON + adapter doc missing -> null (NOT the Firestore doc)', async () => {
    mockState.flagOn = true; mockState.supaDoc = null;
    await expect(getPaymentMethodsSettings()).resolves.toBeNull();
  });

  it('flag ON + adapter error: Firestore fallback', async () => {
    mockState.flagOn = true; mockState.adapterFails = true;
    await expect(getPaymentMethodsSettings()).resolves.toEqual(fsSettings);
  });

  it('flag ON + unconfigured client: Firestore fallback', async () => {
    mockState.flagOn = true; mockState.clientPresent = false;
    await expect(getPaymentMethodsSettings()).resolves.toEqual(fsSettings);
  });
});
