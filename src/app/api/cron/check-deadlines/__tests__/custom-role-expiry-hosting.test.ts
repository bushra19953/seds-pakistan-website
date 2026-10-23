/**
 * @jest-environment node
 *
 * EXPIRY-CORE (plan section 8D): check-deadlines hosts the custom role
 * expiry sweep as a named step at the end of the run (contracts 5.1).
 * The response JSON gains a `customRoleExpirySweep` key beside
 * `governorTermSweep`, and a sweep failure is reported in that key
 * without failing the deadline run. The sweep module is mocked; its
 * behaviour is covered by its own suite. The referral conversion
 * suite in this folder (referral.test.ts) is untouched and must stay
 * green.
 */
import { NextRequest } from 'next/server';

let mockDb: any;
const mockSweep: { impl: null | ((db: any, now: Date) => Promise<any>) } = {
  impl: null,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  ensureAdminInitialized: () => true,
  admin: {},
  adminDb: null,
  getAdminStorage: () => null,
  getLastAdminError: () => null,
  getAdminDiagnostics: () => ({}),
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));
jest.mock(
  '@/lib/server/custom-role-expiry-sweep',
  () => ({
    runCustomRoleExpirySweep: jest.fn(async (db: any, now: Date) => {
      if (!mockSweep.impl) throw new Error('mockSweep.impl not set');
      return mockSweep.impl(db, now);
    }),
  }),
  { virtual: true },
);

import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';
import { GET } from '../route';

process.env.CRON_SECRET = '<redacted>';
function cronReq() {
  return new NextRequest('http://localhost/api/cron/check-deadlines', {
    headers: { authorization: 'Bearer <redacted>' },
  });
}

function baseDb() {
  const db = makeFakeDb();
  db.seed('settings/discipline', {
    cronReferralLive: true,
    referralWindowDays: 28,
    referralMissThreshold: 3,
    shadowMode: true,
  });
  return db;
}

describe('check-deadlines hosting of the custom role expiry sweep (plan 8D)', () => {
  beforeEach(() => {
    mockDb = baseDb();
    mockSweep.impl = async () => ({
      reminded: [],
      expiredMaterialised: [],
      failures: [],
    });
  });

  test('the response JSON gains a customRoleExpirySweep key carrying the sweep summary', async () => {
    mockSweep.impl = async () => ({
      reminded: [{ uid: 'u-1', roleKey: 'custom_poster_team_lead', stage: 't7_sent' }],
      expiredMaterialised: [],
      failures: [],
    });
    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customRoleExpirySweep).toEqual({
      reminded: [{ uid: 'u-1', roleKey: 'custom_poster_team_lead', stage: 't7_sent' }],
      expiredMaterialised: [],
      failures: [],
    });
  });

  test('a forced sweep failure is reported in the key and still returns success for the deadline run', async () => {
    mockSweep.impl = async () => {
      throw new Error('sweep exploded');
    };
    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customRoleExpirySweep).toBeDefined();
    expect(String(body.customRoleExpirySweep.error)).toContain('sweep exploded');
  });
});
