/**
 * @jest-environment node
 *
 * Flag-state tests for GET /api/admin/applications (read-bleed fix A1),
 * modelled on the chapter-applications route-supa suite:
 *
 * - Flag OFF: the Firestore path runs (status where only when a filter
 *   is set; NO orderBy and NO limit — the full filtered set), adapter
 *   never consulted.
 * - Flag ON: the list is served from fs_applications through
 *   src/lib/applications-supa.ts listApplications(), timestamps as ISO
 *   strings or null.
 * - Flag ON + adapter error: the route falls back to Firestore.
 * - No canManageApplications permission: 403, no read at all.
 *
 * Firestore and the adapter are both in-memory fakes — zero live reads.
 */

import { NextRequest } from 'next/server';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';

// --- Firestore fake ---------------------------------------------------------

const firestoreState = {
  listDocs: [] as Array<{ id: string; data: Record<string, any> }>,
  listCalls: 0,
  whereCalls: [] as any[],
};

const fakeDb = {
  collection: (_name: string) => {
    const runGet = async () => {
      firestoreState.listCalls += 1;
      return {
        docs: firestoreState.listDocs.map((d) => ({ id: d.id, data: () => d.data })),
      };
    };
    return {
      where: (...args: any[]) => {
        firestoreState.whereCalls.push(args);
        return { get: runGet };
      },
      get: runGet,
    };
  },
};

const permissionState = { allowed: true };

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'admin-1' }) }),
  },
  getDb: () => fakeDb,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => permissionState.allowed,
}));

import { GET } from '@/app/api/admin/applications/route';

// --- Adapter fake -----------------------------------------------------------

function makeAdapter(store: Map<string, Record<string, any>>, faults: { throwOnList?: boolean } = {}) {
  const calls = { listDocs: [] as any[] };
  const adapter: ApplicationsSupaAdapter = {
    async getDoc() {
      return null;
    },
    async listDocs(_collection, options = {}) {
      calls.listDocs.push(options);
      if (faults.throwOnList) throw new Error('fake adapter list failure');
      let docs: Array<Record<string, any>> = Array.from(store.entries()).map(([id, data]) => ({
        id,
        ...data,
      }));
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') docs = docs.filter((d) => d[field] === value);
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return docs;
    },
    async countDocs() {
      return store.size;
    },
    async setDoc() {
      return null;
    },
    async updateDoc() {
      return null;
    },
    async deleteDoc() {
      return undefined;
    },
  };
  return { adapter, calls };
}

function req(query = '') {
  return new NextRequest(`http://localhost/api/admin/applications${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetApplicationsSupaAdapterForTests();
  permissionState.allowed = true;
  firestoreState.listDocs = [
    {
      id: 'fs-uid-1',
      data: {
        fullName: 'Firestore Applicant',
        status: 'pending',
        // Firestore docs carry Timestamps (toDate), not JS Dates.
        created_at: { toDate: () => new Date('2026-09-01T00:00:00.000Z') },
        updated_at: { toDate: () => new Date('2026-09-02T00:00:00.000Z') },
      },
    },
  ];
  firestoreState.listCalls = 0;
  firestoreState.whereCalls = [];
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  __resetApplicationsSupaAdapterForTests();
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('GET /api/admin/applications flag states', () => {
  it('flag OFF: Firestore path runs unchanged, adapter never consulted', async () => {
    const { adapter, calls } = makeAdapter(new Map());
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].id).toBe('fs-uid-1');
    expect(body.applications[0].created_at).toBe('2026-09-01T00:00:00.000Z');
    expect(body.applications[0].updated_at).toBe('2026-09-02T00:00:00.000Z');
    expect(body.applications[0].last_saved_at).toBeNull();
    expect(firestoreState.listCalls).toBe(1);
    expect(firestoreState.whereCalls).toHaveLength(0);
    expect(calls.listDocs).toHaveLength(0);
  });

  it('flag OFF: a status filter is pushed as a Firestore where', async () => {
    const { adapter } = makeAdapter(new Map());
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('?status=pending'));
    expect(res.status).toBe(200);
    expect(firestoreState.whereCalls).toEqual([['status', '==', 'pending']]);
    expect(firestoreState.listCalls).toBe(1);
  });

  it('flag ON: list served from the adapter, full set, no limit/orderBy', async () => {
    process.env[ENV_KEY] = 'applications';
    const store = new Map<string, Record<string, any>>([
      ['supa-uid-1', { fullName: 'Supa One', status: 'pending', created_at: '2026-10-05T00:00:00.000Z' }],
      ['supa-uid-2', { fullName: 'Supa Two', status: 'approved', created_at: '2026-10-06T00:00:00.000Z', reviewedAt: { _seconds: 1791000000, _nanoseconds: 0 } }],
    ]);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications.map((a: any) => a.id)).toEqual(['supa-uid-1', 'supa-uid-2']);
    expect(body.applications[0].created_at).toBe('2026-10-05T00:00:00.000Z');
    expect(body.applications[1].reviewedAt).toBe(new Date(1791000000 * 1000).toISOString());
    expect(firestoreState.listCalls).toBe(0);
    expect(calls.listDocs).toHaveLength(1);
    expect(calls.listDocs[0].limit).toBeUndefined();
    expect(calls.listDocs[0].orderBy).toBeUndefined();
    expect(calls.listDocs[0].where).toBeUndefined();
  });

  it('flag ON: status filter is forwarded to the adapter query', async () => {
    process.env[ENV_KEY] = 'applications';
    const store = new Map<string, Record<string, any>>([
      ['a1', { status: 'approved', created_at: '2026-10-02T00:00:00.000Z' }],
      ['a2', { status: 'rejected', created_at: '2026-10-01T00:00:00.000Z' }],
    ]);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('?status=approved'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications.map((a: any) => a.id)).toEqual(['a1']);
    expect(calls.listDocs[0].where).toEqual([['status', '==', 'approved']]);
  });

  it('flag ON + adapter error: falls back to the Firestore list', async () => {
    process.env[ENV_KEY] = 'applications';
    const { adapter } = makeAdapter(new Map(), { throwOnList: true });
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].id).toBe('fs-uid-1');
    expect(firestoreState.listCalls).toBe(1);
  });

  it('forbidden without canManageApplications: 403 and no read', async () => {
    permissionState.allowed = false;
    const { adapter, calls } = makeAdapter(new Map());
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(firestoreState.listCalls).toBe(0);
    expect(calls.listDocs).toHaveLength(0);
  });

  it('unauthorized without a Bearer token: 401', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/admin/applications', { method: 'GET' }),
    );
    expect(res.status).toBe(401);
  });
});
