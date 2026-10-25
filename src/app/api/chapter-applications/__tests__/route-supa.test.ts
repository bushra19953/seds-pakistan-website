/**
 * @jest-environment node
 *
 * Supa flag-state tests for /api/chapter-applications (APPS-1 seam).
 *
 * - Flag OFF: the Firestore path runs exactly as before; the injected
 *   adapter is never consulted.
 * - Flag ON: the list is served from fs_chapter_applications through
 *   src/lib/applications-supa.ts with the identical response shape
 *   (timestamps as ISO strings or null).
 * - Flag ON + adapter error: the route falls back to Firestore.
 *
 * Firestore and the adapter are both in-memory fakes — zero live reads.
 * The pre-existing parity suite (route-parity.test.ts) is untouched and
 * covers the permission gate; here the gate is mocked open.
 */

import { NextRequest } from 'next/server';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';
import { notificationService } from '@/lib/server/notification-service';

// --- Firestore fake ---------------------------------------------------------

const firestoreState = {
  listDocs: [] as Array<{ id: string; data: Record<string, any> }>,
  docData: null as Record<string, any> | null,
  listCalls: 0,
  docCalls: 0,
};

const fakeDb = {
  collection: (_name: string) => ({
    orderBy: () => ({
      where: () => ({
        limit: () => ({
          get: async () => {
            firestoreState.listCalls += 1;
            return { docs: firestoreState.listDocs.map((d) => ({ id: d.id, data: () => d.data })) };
          },
        }),
      }),
      limit: () => ({
        get: async () => {
          firestoreState.listCalls += 1;
          return { docs: firestoreState.listDocs.map((d) => ({ id: d.id, data: () => d.data })) };
        },
      }),
    }),
    doc: (_id: string) => ({
      get: async () => {
        firestoreState.docCalls += 1;
        return { exists: firestoreState.docData !== null, data: () => firestoreState.docData ?? undefined };
      },
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'admin-1' }) }),
    firestore: {
      FieldValue: { serverTimestamp: () => new Date(), delete: () => ({ __delete: true }) },
    },
  },
  getDb: () => fakeDb,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => true,
}));

jest.mock('@/app/actions/chapter-applications', () => ({
  updateChapterApplicationStatus: jest.fn(async () => ({ success: true, chapterId: 'chap-1' })),
  deleteChapterWithCleanup: jest.fn(async () => ({ success: true, usersUpdated: 0 })),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

jest.mock('@/lib/server/consent-gate', () => ({
  consentGateHttpError: jest.fn(() => ({ status: 409, body: { error: 'consent required' } })),
}));

jest.mock('@/lib/server/consent-gate-types', () => {
  class ConsentRequiredError extends Error {}
  return { ConsentRequiredError };
});

import { GET, PATCH } from '@/app/api/chapter-applications/route';

// --- Adapter fake -----------------------------------------------------------

function makeAdapter(store: Map<string, Record<string, any>>, faults: { throwOnList?: boolean } = {}) {
  const calls = { listDocs: [] as any[], getDoc: [] as any[] };
  const adapter: ApplicationsSupaAdapter = {
    async getDoc(_collection, id) {
      calls.getDoc.push(id);
      const data = store.get(id);
      return data ? { id, ...data } : null;
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
      docs.sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
      return docs.slice(0, options.limit ?? docs.length);
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

function req(method: string, body?: unknown, query = '') {
  return new NextRequest(`http://localhost/api/chapter-applications${query}`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetApplicationsSupaAdapterForTests();
  firestoreState.listDocs = [
    {
      id: 'fs-app-1',
      data: {
        applicantId: 'applicant-fs',
        proposedChapterName: 'Firestore Chapter',
        status: 'pending_review',
        // Firestore docs carry Timestamps (toDate), not JS Dates.
        createdAt: { toDate: () => new Date('2026-09-01T00:00:00.000Z') },
        updatedAt: { toDate: () => new Date('2026-09-02T00:00:00.000Z') },
        reviewedAt: null,
      },
    },
  ];
  firestoreState.docData = null;
  firestoreState.listCalls = 0;
  firestoreState.docCalls = 0;
  (notificationService.send as jest.Mock).mockClear();
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

describe('GET /api/chapter-applications supa flag states', () => {
  it('flag OFF: Firestore path runs unchanged, adapter never consulted', async () => {
    const { adapter, calls } = makeAdapter(new Map());
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].id).toBe('fs-app-1');
    expect(body.applications[0].createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(body.applications[0].reviewedAt).toBeNull();
    expect(firestoreState.listCalls).toBe(1);
    expect(calls.listDocs).toHaveLength(0);
  });

  it('flag ON: list served from the adapter with the identical shape', async () => {
    process.env[ENV_KEY] = 'applications';
    const store = new Map<string, Record<string, any>>([
      [
        'supa-app-1',
        {
          applicantId: 'applicant-supa',
          proposedChapterName: 'Supa Chapter',
          status: 'approved',
          createdAt: '2026-10-05T00:00:00.000Z',
          updatedAt: { _seconds: 1791000000, _nanoseconds: 0 },
          // reviewedAt absent entirely -> null, as a missing Firestore field maps
        },
      ],
    ]);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].id).toBe('supa-app-1');
    expect(body.applications[0].proposedChapterName).toBe('Supa Chapter');
    expect(body.applications[0].createdAt).toBe('2026-10-05T00:00:00.000Z');
    expect(body.applications[0].updatedAt).toBe(new Date(1791000000 * 1000).toISOString());
    expect(body.applications[0].reviewedAt).toBeNull();
    expect(firestoreState.listCalls).toBe(0);
    expect(calls.listDocs).toHaveLength(1);
    expect(calls.listDocs[0]).toMatchObject({ limit: 100 });
  });

  it('flag ON: status filter is forwarded to the adapter query', async () => {
    process.env[ENV_KEY] = 'applications';
    const store = new Map<string, Record<string, any>>([
      ['a1', { status: 'approved', createdAt: '2026-10-02T00:00:00.000Z' }],
      ['a2', { status: 'rejected', createdAt: '2026-10-01T00:00:00.000Z' }],
    ]);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('GET', undefined, '?status=approved'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications.map((a: any) => a.id)).toEqual(['a1']);
    expect(calls.listDocs[0].where).toEqual([['status', '==', 'approved']]);
  });

  it('flag ON + adapter error: falls back to the Firestore list', async () => {
    process.env[ENV_KEY] = 'applications';
    const { adapter } = makeAdapter(new Map(), { throwOnList: true });
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].id).toBe('fs-app-1');
    expect(firestoreState.listCalls).toBe(1);
  });
});

describe('PATCH /api/chapter-applications notification fetch', () => {
  it('flag ON: applicant data for notifications comes from the adapter', async () => {
    process.env[ENV_KEY] = 'applications';
    const store = new Map<string, Record<string, any>>([
      ['app-9', { applicantId: 'applicant-supa-9', proposedChapterName: 'Supa Nine' }],
    ]);
    const { adapter, calls } = makeAdapter(store);
    __setApplicationsSupaAdapterForTests(adapter);

    const res = await PATCH(req('PATCH', { applicationId: 'app-9', status: 'under_review' }));
    expect(res.status).toBe(200);
    expect(calls.getDoc).toEqual(['app-9']);
    expect(firestoreState.docCalls).toBe(0);
    expect(notificationService.send).toHaveBeenCalledWith(
      'applicant-supa-9',
      expect.objectContaining({ type: 'chapter_application' }),
      'P2',
    );
  });

  it('flag OFF: applicant data comes from Firestore, as before', async () => {
    const { adapter, calls } = makeAdapter(new Map());
    __setApplicationsSupaAdapterForTests(adapter);
    firestoreState.docData = { applicantId: 'applicant-fs-9', proposedChapterName: 'FS Nine' };

    const res = await PATCH(req('PATCH', { applicationId: 'app-9', status: 'under_review' }));
    expect(res.status).toBe(200);
    expect(calls.getDoc).toHaveLength(0);
    expect(firestoreState.docCalls).toBe(1);
    expect(notificationService.send).toHaveBeenCalledWith(
      'applicant-fs-9',
      expect.objectContaining({ type: 'chapter_application' }),
      'P2',
    );
  });
});
