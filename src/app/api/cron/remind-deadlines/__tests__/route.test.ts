/**
 * @jest-environment node
 *
 * B3 auth tests for GET/POST /api/cron/remind-deadlines
 * (cron-takeover auth patches).
 *
 * After the B3 patch the cron arm is
 * `!!CRON_SECRET && authHeader === Bearer <secret>`. When the secret
 * is unset, 'Bearer undefined' no longer counts as cron: the request
 * falls through to verifyAuthentication, which (mocked unauthenticated
 * here, as a request with no Firebase token) rejects 401.
 *
 * Firestore is mocked (empty task snapshots for both passes), so the
 * tests run fully offline and the success path is the route's normal
 * 200 summary with zero reminders/nudges sent.
 */
import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  sendCalls: 0,
};

const emptySnap = { docs: [] as any[], size: 0, empty: true };

const mockDb = {
  collection: (name: string) => {
    if (name !== 'tasks') throw new Error(`unexpected collection: ${name}`);
    const query: any = {
      where: () => query,
      get: async () => emptySnap,
    };
    return query;
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => {
      state.sendCalls += 1;
    }),
  },
}));

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => new Date(),
        delete: () => null,
      },
    },
  },
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
  state.sendCalls = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/remind-deadlines', {
    method,
    headers,
  });
}

describe('GET/POST /api/cron/remind-deadlines — B3 cron auth', () => {
  it('1. no Authorization header -> 401, nothing sent', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(state.sendCalls).toBe(0);
  });

  it('2. wrong bearer (secret set) -> 401, nothing sent', async () => {
    const res = await GET(req({ Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(state.sendCalls).toBe(0);
  });

  it("3. CRON_SECRET unset + 'Bearer undefined' -> 401 via the auth arm", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req({ Authorization: 'Bearer undefined' }));
    expect(res.status).toBe(401);
    expect(state.sendCalls).toBe(0);
  });

  it('4. correct bearer (secret set) -> accepted, handler proceeds', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.reminders).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(body.acceptanceNudges).toEqual({ sent: 0, skipped: 0 });
  });

  it('4b. correct bearer via POST -> accepted', async () => {
    const res = await POST(
      req({ Authorization: `Bearer ${SECRET}` }, 'POST'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});
