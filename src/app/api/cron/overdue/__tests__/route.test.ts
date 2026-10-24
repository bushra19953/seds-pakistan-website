/**
 * @jest-environment node
 *
 * B2 auth tests for GET /api/cron/overdue (cron-takeover auth patches).
 *
 * After the B2 patch the route requires a guarded cron bearer in ALL
 * environments: `!!CRON_SECRET && authHeader === Bearer <secret>`.
 * There is no x-vercel-cron bypass, no VERCEL_ENV gate and no fallback
 * credential. Every rejection is 401.
 *
 * Downstream Firestore is mocked (empty task snapshot, no workflow
 * release setting), so these tests run fully offline and the success
 * path is the route's normal 200 summary.
 */
import { NextRequest } from 'next/server';

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') {
      const query: any = {
        where: () => query,
        get: async () => ({ docs: [], size: 0, empty: true }),
      };
      return query;
    }
    if (name === 'settings') {
      return {
        doc: (_id: string) => ({
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    update: jest.fn(),
    commit: jest.fn(async () => undefined),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/bug4-proof-guards', () => ({
  taskHasProofUploaded: jest.fn(() => false),
}));

import { GET } from '../route';

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
  process.env.CRON_SECRET = SECRET;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/overdue', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/overdue — B2 cron auth', () => {
  it('1. no Authorization header -> 401', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('2. wrong bearer (secret set) -> 401', async () => {
    const res = await GET(req({ Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it("3. CRON_SECRET unset + 'Bearer undefined' -> 401", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req({ Authorization: 'Bearer undefined' }));
    expect(res.status).toBe(401);
  });

  it('4. correct bearer (secret set) -> accepted, handler proceeds', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.scanned).toBe(0);
    expect(body.newlyMarked).toBe(0);
  });

  it('B2 extra: x-vercel-cron header present + no bearer -> 401', async () => {
    const res = await GET(req({ 'x-vercel-cron': '1' }));
    expect(res.status).toBe(401);
  });

  it('B2 extra: VERCEL_ENV unset + correct bearer -> accepted', async () => {
    delete process.env.VERCEL_ENV;
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('B2 extra: VERCEL_ENV=production + x-vercel-cron + wrong bearer -> 401', async () => {
    process.env.VERCEL_ENV = 'production';
    const res = await GET(
      req({ 'x-vercel-cron': '1', Authorization: 'Bearer wrong-secret' }),
    );
    expect(res.status).toBe(401);
  });

  it('B2 extra: VERCEL_ENV=production + x-vercel-cron + no bearer -> 401', async () => {
    process.env.VERCEL_ENV = 'production';
    const res = await GET(req({ 'x-vercel-cron': '1' }));
    expect(res.status).toBe(401);
  });
});
