/**
 * @jest-environment node
 *
 * Tests for GET /api/public/skills.
 *
 * (a) Returns all skills when no filter params are given, sorted by
 *     displayOrder then name.
 * (b) Filters by status, category, featured, and free-text search q.
 * (c) An empty `skills` collection returns { items: [] }, not an error.
 * (d) Firebase Admin / Firestore init failures return 500.
 */

const mockState = {
  adminReady: true,
  dbReady: true,
  getError: null as unknown,
  skills: [] as Array<Record<string, any>>,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => mockState.adminReady),
  getDb: jest.fn(() =>
    mockState.dbReady
      ? {
          collection: (_name: string) => ({
            get: async () => {
              if (mockState.getError) throw mockState.getError;
              return {
                docs: mockState.skills.map((s) => ({
                  id: s.id,
                  data: () => s,
                })),
              };
            },
          }),
        }
      : null,
  ),
}));

import { GET } from '@/app/api/public/skills/route';
import { NextRequest } from 'next/server';

const DEFAULT_SKILLS: Array<Record<string, any>> = [
  { id: 's1', name: 'Rocketry', category: 'Engineering', status: 'active', isFeatured: true, displayOrder: 2 },
  { id: 's2', name: 'Astrophysics', category: 'Science', status: 'active', isFeatured: false, displayOrder: 1 },
  { id: 's3', name: 'Avionics Design', category: 'Engineering', status: 'inactive', isFeatured: false, displayOrder: 3 },
  { id: 's4', name: 'CubeSat Comms', category: 'Engineering', status: 'active', isFeatured: false },
];

function getRequest(path = 'http://localhost/api/public/skills') {
  return new NextRequest(path);
}

beforeEach(() => {
  mockState.adminReady = true;
  mockState.dbReady = true;
  mockState.getError = null;
  mockState.skills = DEFAULT_SKILLS.map((s) => ({ ...s }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/public/skills', () => {
  it('returns all skills sorted by displayOrder then name', async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(4);
    expect(body.items.map((s: any) => s.id)).toEqual(['s2', 's1', 's3', 's4']);
    expect(body.items[0]).toMatchObject({ id: 's2', name: 'Astrophysics' });
  });

  it('filters by status', async () => {
    const res = await GET(getRequest('http://localhost/api/public/skills?status=active'));
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.every((s: any) => s.status !== 'inactive')).toBe(true);
  });

  it('treats a missing status as active when status is given', async () => {
    mockState.skills.push({ id: 's5', name: 'No Status', category: 'Science' });
    const res = await GET(getRequest('http://localhost/api/public/skills?status=active'));
    const body = await res.json();
    expect(body.items.map((s: any) => s.id)).toContain('s5');
  });

  it('status=_all returns every skill regardless of status', async () => {
    const res = await GET(getRequest('http://localhost/api/public/skills?status=_all'));
    const body = await res.json();
    expect(body.items).toHaveLength(4);
    expect(body.items.map((s: any) => s.id)).toContain('s3');
  });

  it('filters by category', async () => {
    const res = await GET(getRequest('http://localhost/api/public/skills?category=Engineering'));
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.every((s: any) => s.category === 'Engineering')).toBe(true);
  });

  it('filters to featured skills with featured=1', async () => {
    const res = await GET(getRequest('http://localhost/api/public/skills?featured=1'));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('s1');
  });

  it('searches by name with q, case-insensitive', async () => {
    const res = await GET(getRequest('http://localhost/api/public/skills?q=cube'));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('s4');

    const upper = await GET(getRequest('http://localhost/api/public/skills?q=ROCKET'));
    const upperBody = await upper.json();
    expect(upperBody.items).toHaveLength(1);
    expect(upperBody.items[0].id).toBe('s1');
  });

  it('combines multiple filters', async () => {
    const res = await GET(
      getRequest('http://localhost/api/public/skills?status=active&category=Engineering&q=comms'),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('s4');
  });

  it('returns an empty items array when the collection is empty', async () => {
    mockState.skills = [];
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('returns 500 when Firebase Admin is not initialized', async () => {
    mockState.adminReady = false;
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Firebase Admin/i);
  });

  it('returns 500 when Firestore is not initialized', async () => {
    mockState.dbReady = false;
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Firestore not initialized/);
  });

  it('returns 500 when the Firestore read throws', async () => {
    mockState.getError = new Error('firestore down');
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/firestore down/);
  });
});
