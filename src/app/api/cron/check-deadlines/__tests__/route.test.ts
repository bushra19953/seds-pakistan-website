/**
 * @jest-environment node
 *
 * B3 auth tests for GET/POST /api/cron/check-deadlines
 * (cron-takeover auth patches).
 *
 * After the B3 patch the cron arm is
 * `!!CRON_SECRET && authHeader === Bearer <secret>`. When the secret
 * is unset, 'Bearer undefined' no longer counts as cron: the request
 * falls through to verifyAuthentication, which (mocked unauthenticated
 * here, as a request with no Firebase token) rejects 401.
 *
 * Downstream is mocked: getDisciplineSettings returns the default
 * shadow settings (cronReferralLive false), so a correctly
 * authenticated run returns the route's shadow-mode 200 summary and
 * performs no writes. Tests run fully offline; the live referral
 * behaviour is covered by referral.test.ts in this folder.
 */
import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => ({})),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

jest.mock('@/lib/server/discipline/settings', () => ({
  getDisciplineSettings: jest.fn(async () => ({
    shadowMode: true,
    cronReferralLive: false,
    referralWindowDays: 28,
    referralMissThreshold: 3,
    warningRegistryVariant: 'retired',
  })),
}));

jest.mock('@/lib/server/discipline/miss-records', () => ({
  recordMiss: jest.fn(async () => ({ created: false })),
  evaluateReferralPatterns: jest.fn(async () => ({
    draftsCreated: 0,
    digestsSent: 0,
  })),
}));

jest.mock('@/lib/server/leave-exemption', () => ({
  isExemptFromDeadlinePenalty: jest.fn(() => ({ exempt: false })),
}));

jest.mock('@/lib/server/bug4-proof-guards', () => ({
  taskHasProofUploaded: jest.fn(() => false),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

const ENV_KEYS: string[] = ['CRON_SECRET', 'VERCEL_ENV', 'NODE_ENV'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/check-deadlines', {
    method,
    headers,
  });
}

describe('GET/POST /api/cron/check-deadlines — B3 cron auth', () => {
  it('1. no Authorization header -> 401', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('2. wrong bearer (secret set) -> 401', async () => {
    const res = await GET(req({ Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it("3. CRON_SECRET unset + 'Bearer undefined' -> 401 via the auth arm", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req({ Authorization: 'Bearer undefined' }));
    expect(res.status).toBe(401);
  });

  it('4. correct bearer (secret set) -> accepted, handler proceeds (shadow summary)', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.missRecordsCreated).toBe(0);
    expect(String(body.message)).toContain('Shadow mode');
  });

  it('4b. correct bearer via POST -> accepted', async () => {
    const res = await POST(
      req({ Authorization: `Bearer ${SECRET}` }, 'POST'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});
