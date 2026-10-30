/**
 * @jest-environment node
 *
 * Founder shelter (Part B2): GET /api/public/skills stale-serving.
 * A successful response is remembered per filter set; when the
 * Firestore fallback read then throws code 8 (RESOURCE_EXHAUSTED,
 * the 2026-10-30 quota death) the route serves the last-good body
 * with X-Served-Stale instead of a 500. With no last-good on hand
 * the failure stays a loud 500 - never a false-empty success.
 */

const mockState = {
  getError: null as unknown,
  skills: [] as Array<Record<string, any>>,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => {
    const makeQuery = (items: Array<Record<string, any>>): any => ({
      where: (field: string, _op: string, value: unknown) =>
        makeQuery(items.filter((s) => s[field] === value)),
      limit: (count: number) => makeQuery(items.slice(0, count)),
      get: async () => {
        if (mockState.getError) throw mockState.getError;
        return {
          empty: items.length === 0,
          docs: items.map((s) => ({ id: s.id, data: () => s })),
        };
      },
    });
    return {
      collection: (_name: string) => ({
        ...makeQuery(mockState.skills),
        doc: (_id: string) => ({ set: async () => {} }),
      }),
    };
  }),
}));

import { GET, __resetSkillsSeedGuard } from '@/app/api/public/skills/route';
import { resetPublicStaleCache } from '@/lib/server/public-stale-cache';
import { NextRequest } from 'next/server';

function quotaError(): Error {
  const err = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.') as Error & { code?: number };
  err.code = 8;
  return err;
}

beforeEach(() => {
  resetPublicStaleCache();
  __resetSkillsSeedGuard();
  mockState.getError = null;
  mockState.skills = [
    { id: 's1', name: 'Rocketry', category: 'Engineering', status: 'active', displayOrder: 1 },
  ];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/public/skills stale-serving', () => {
  it('serves the last-good body (200, X-Served-Stale) when the read throws code 8', async () => {
    const ok = await GET(new NextRequest('http://localhost/api/public/skills'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('stale-while-revalidate=3600');
    const okBody = await ok.json();
    expect(okBody.items).toHaveLength(1);

    mockState.getError = quotaError();
    const stale = await GET(new NextRequest('http://localhost/api/public/skills'));
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-served-stale')).toBe('last-good');
    expect(await stale.json()).toEqual(okBody);
  });

  it('with no last-good for the filter set, a code-8 failure is a loud 500', async () => {
    mockState.getError = quotaError();
    const res = await GET(new NextRequest('http://localhost/api/public/skills?category=Science'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.items).toBeUndefined();
  });
});
