/**
 * @jest-environment node
 *
 * Cluster G (skills) contracts for POST /api/skills/migrate-legacy.
 *
 * Pins:
 *  - flag OFF -> the Firestore slug probe drives create/update exactly as
 *    before; the adapter is never called; writes are still mirrored as
 *    no-ops (nothing reaches Supabase)
 *  - flag ON  -> the slug probe is served from fs_skills (no Firestore
 *    where-query), writes stay Firestore-primary and are mirrored
 *  - adapter error -> probe falls back to Firestore (seam returns
 *    undefined), run completes as before
 *
 * Everything is mocked. Zero live reads. The legacy list has 18 entries;
 * the fake seeds one existing slug ('programming') so both branches run.
 */

const mockSupa = {
  enabled: false,
  fail: false,
  calls: [] as string[],
  skills: new Map<string, Record<string, any>>(),
};

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => surface === 'skills' && mockSupa.enabled,
  getSupaClient: () => ({}),
  getSupaAdapter: () => ({
    listDocs: async (_col: string, options: any = {}) => {
      mockSupa.calls.push('listDocs');
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      let rows = [...mockSupa.skills.entries()].map(([id, data]) => ({ id, ...data }));
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') rows = rows.filter((r: any) => r[field] === value);
      }
      if (typeof options.limit === 'number') rows = rows.slice(0, options.limit);
      return rows;
    },
    getDoc: async () => null,
    setDoc: async (_col: string, id: string, data: any, options?: any) => {
      mockSupa.calls.push('setDoc');
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      mockSupa.skills.set(id, options?.merge ? { ...(mockSupa.skills.get(id) ?? {}), ...data } : { ...data });
      return { id, ...data };
    },
    updateDoc: async () => ({}),
    deleteDoc: async () => undefined,
    countDocs: async () => 0,
  }),
}));

const mockFs = {
  whereCalls: 0,
  skills: new Map<string, Record<string, any>>(),
  addCounter: 0,
};

function fsCollection() {
  return {
    where: (field: string, op: string, value: any) => ({
      limit: (_n: number) => ({
        get: async () => {
          mockFs.whereCalls += 1;
          const hits = [...mockFs.skills.entries()].filter(([, d]) => d[field] === value);
          return {
            empty: hits.length === 0,
            docs: hits.map(([id, data]) => ({
              id,
              data: () => data,
              ref: {
                id,
                set: async (data2: Record<string, any>, opts?: any) => {
                  mockFs.skills.set(id, opts?.merge ? { ...(mockFs.skills.get(id) ?? {}), ...data2 } : { ...data2 });
                },
              },
            })),
          };
        },
      }),
    }),
    add: async (data: Record<string, any>) => {
      const id = `added-${++mockFs.addCounter}`;
      mockFs.skills.set(id, { ...data });
      return { id };
    },
    doc: (id: string) => ({
      id,
      set: async (data: Record<string, any>, opts?: any) => {
        mockFs.skills.set(id, opts?.merge ? { ...(mockFs.skills.get(id) ?? {}), ...data } : { ...data });
      },
    }),
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({ collection: (_name: string) => fsCollection() }),
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'admin-1' }) }),
  },
}));

import { POST } from '@/app/api/skills/migrate-legacy/route';
import { NextRequest } from 'next/server';

function req() {
  return new NextRequest('http://localhost/api/skills/migrate-legacy', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  });
}

beforeEach(() => {
  mockSupa.enabled = false;
  mockSupa.fail = false;
  mockSupa.calls = [];
  mockSupa.skills = new Map([['programming', { name: 'Programming', slug: 'programming', category: 'General Skills', status: 'active' }]]);
  mockFs.whereCalls = 0;
  mockFs.skills = new Map([['programming', { name: 'Programming', slug: 'programming', category: 'General Skills', status: 'active' }]]);
  mockFs.addCounter = 0;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('POST /api/skills/migrate-legacy', () => {
  it('flag OFF: Firestore probe drives the run (17 created, 1 updated), adapter untouched', async () => {
    const res = await POST(req());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ created: 17, updated: 1 });
    expect(mockFs.whereCalls).toBe(18);
    expect(mockSupa.calls).toEqual([]);
  });

  it('flag ON: slug probe served from fs_skills, writes mirrored', async () => {
    mockSupa.enabled = true;
    const res = await POST(req());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ created: 17, updated: 1 });
    expect(mockFs.whereCalls).toBe(0);
    expect(mockSupa.skills.size).toBe(18);
    expect(mockFs.skills.size).toBe(18);
  });

  it('flag ON + adapter error: probe falls back to Firestore, run unchanged', async () => {
    mockSupa.enabled = true;
    mockSupa.fail = true;
    const res = await POST(req());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ created: 17, updated: 1 });
    expect(mockFs.whereCalls).toBe(18);
    expect(mockFs.skills.size).toBe(18);
  });
});
