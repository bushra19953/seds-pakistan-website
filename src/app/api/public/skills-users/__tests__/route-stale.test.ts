/**
 * @jest-environment node
 *
 * Founder shelter (Part B2): GET /api/public/skills-users stale-serving.
 * A successful response is remembered per skillId; when the Firestore
 * read then throws code 8 (RESOURCE_EXHAUSTED, the 2026-10-30 quota
 * death) the route serves the last-good body with X-Served-Stale
 * instead of a 500. With no last-good on hand the failure stays a
 * loud 500 - never a false-empty { items: [] } success.
 */

const mockState = {
  getError: null as unknown,
  users: [] as Array<Record<string, any>>,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => ({
    collection: (_name: string) => ({
      where: (_field: string, _op: string, value: unknown) => ({
        get: async () => {
          if (mockState.getError) throw mockState.getError;
          return {
            docs: mockState.users
              .filter((u) => Array.isArray(u.skillIds) && u.skillIds.includes(value))
              .map((u) => ({ id: u.id, data: () => u })),
          };
        },
      }),
    }),
  })),
}));

import { GET } from '@/app/api/public/skills-users/route';
import { resetPublicStaleCache } from '@/lib/server/public-stale-cache';
import { NextRequest } from 'next/server';

function quotaError(): Error {
  const err = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.') as Error & { code?: number };
  err.code = 8;
  return err;
}

function getRequest(path: string) {
  return new NextRequest(path);
}

beforeEach(() => {
  resetPublicStaleCache();
  mockState.getError = null;
  mockState.users = [
    { id: 'u1', displayName: 'Member One', photoURL: null, chapterId: 'seds-ist-chapter', skillIds: ['avionics'] },
  ];
});

describe('GET /api/public/skills-users stale-serving', () => {
  it('serves the last-good body (200, X-Served-Stale) when the read throws code 8', async () => {
    const ok = await GET(getRequest('http://localhost/api/public/skills-users?skillId=avionics'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('stale-while-revalidate=3600');
    const okBody = await ok.json();
    expect(okBody.items).toHaveLength(1);

    mockState.getError = quotaError();
    const stale = await GET(getRequest('http://localhost/api/public/skills-users?skillId=avionics'));
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-served-stale')).toBe('last-good');
    expect(await stale.json()).toEqual(okBody);
  });

  it('with no last-good, a code-8 failure is a loud 500, never a false-empty success', async () => {
    mockState.getError = quotaError();
    const res = await GET(getRequest('http://localhost/api/public/skills-users?skillId=avionics'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.items).toBeUndefined();
  });

  it('last-good is keyed per skillId: a different skill does not inherit it', async () => {
    await GET(getRequest('http://localhost/api/public/skills-users?skillId=avionics'));
    mockState.getError = quotaError();
    const res = await GET(getRequest('http://localhost/api/public/skills-users?skillId=rocketry'));
    expect(res.status).toBe(500);
  });
});
