/**
 * @jest-environment node
 *
 * B4 auth tests for GET /api/cron/process-dlq (cron-takeover auth patches).
 *
 * After the B4 patch the expected credential is the env CRON_SECRET
 * only: the hardcoded fallback literal that used to live in route.ts
 * is removed. An unset/empty secret fails closed with
 * 500 'CRON_SECRET is not configured'; a missing or wrong bearer is
 * 401 in ALL environments, including NODE_ENV=development.
 *
 * Firestore is mocked (empty DLQ snapshot), so the tests run fully
 * offline and the success path is the route's 'DLQ is empty' 200.
 */
import { NextRequest } from 'next/server';

const mockDb = {
  collection: (name: string) => {
    if (name !== 'dlq_points_retry') {
      throw new Error(`unexpected collection: ${name}`);
    }
    const query: any = {
      where: () => query,
      limit: () => query,
      get: async () => ({ docs: [], size: 0, empty: true }),
    };
    return query;
  },
  batch: () => ({
    update: jest.fn(),
    set: jest.fn(),
    commit: jest.fn(async () => undefined),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => new Date(),
        increment: (n: number) => n,
      },
      Timestamp: {
        now: () => new Date(),
        fromMillis: (ms: number) => new Date(ms),
      },
    },
  },
}));

import { GET } from '../route';

const SECRET = 'test-cron-secret';
// Negative test vector ONLY: the fallback credential hardcoded in the
// pre-patch route (process-dlq/route.ts, `CRON_SECRET || <literal>`).
// After B4 it must never authenticate, in any environment.
const LEGACY_FALLBACK = 'local-cron-secret';

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
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/process-dlq', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/process-dlq — B4 cron auth', () => {
  it('1. no Authorization header (secret set) -> 401', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('2. wrong bearer (secret set) -> 401', async () => {
    const res = await GET(req({ Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it("3. CRON_SECRET unset + 'Bearer undefined' -> fail-closed 500", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req({ Authorization: 'Bearer undefined' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('CRON_SECRET is not configured');
  });

  it('3b. CRON_SECRET empty string -> fail-closed 500', async () => {
    process.env.CRON_SECRET = '';
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('CRON_SECRET is not configured');
  });

  it('4. correct bearer (secret set) -> accepted, handler proceeds', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(
      'DLQ is empty. No operations to retry.',
    );
  });

  it('B4 extra: NODE_ENV=development + wrong bearer -> 401', async () => {
    Object.assign(process.env, { NODE_ENV: 'development' });
    const res = await GET(req({ Authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it('B4 extra: NODE_ENV=development + no bearer -> 401', async () => {
    Object.assign(process.env, { NODE_ENV: 'development' });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('B4 extra: NODE_ENV=development + secret unset -> 500', async () => {
    Object.assign(process.env, { NODE_ENV: 'development' });
    delete process.env.CRON_SECRET;
    const res = await GET(req({ Authorization: 'Bearer undefined' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('CRON_SECRET is not configured');
  });

  it('B4 extra: previously hardcoded fallback literal as bearer -> 401', async () => {
    const res = await GET(
      req({ Authorization: `Bearer ${LEGACY_FALLBACK}` }),
    );
    expect(res.status).toBe(401);
  });

  it('B4 extra: fallback literal in development (its old bypass env) -> 401', async () => {
    Object.assign(process.env, { NODE_ENV: 'development' });
    const res = await GET(
      req({ Authorization: `Bearer ${LEGACY_FALLBACK}` }),
    );
    expect(res.status).toBe(401);
  });
});
