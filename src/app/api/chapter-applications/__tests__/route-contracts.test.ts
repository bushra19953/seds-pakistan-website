/**
 * @jest-environment node
 *
 * Route-level parity contracts for /api/chapter-applications that the
 * APPS-1 slice suites (route-parity.test.ts, route-supa.test.ts) leave
 * UNPINNED:
 *  1. PATCH flag ON + adapter error on the notification fetch: falls
 *     back to the Firestore doc (route-supa pins ON-success and OFF,
 *     not the error fallback).
 *  2. GET flag ON + adapter returns an EMPTY list: the route returns
 *     { applications: [] } from the seam and does NOT fall back to
 *     Firestore (empty is an answer, not an error).
 *  3. DELETE success/validation response shapes (route-parity pins
 *     only the permission gate for DELETE). Always-on: the DELETE
 *     handler delegates to the actions file and consults no seam
 *     itself, so these pin current behavior in every flag state.
 *
 * On the base tree the seam module does not exist yet; the flag-state
 * contracts skip with that reason and activate on the merged tree.
 */

import * as fs from 'fs';
import * as path from 'path';

const SEAM_WIRED =
  fs.existsSync(path.join(process.cwd(), 'src/lib/applications-supa.ts')) &&
  fs
    .readFileSync(
      path.join(process.cwd(), 'src/app/api/chapter-applications/route.ts'),
      'utf8',
    )
    .includes('applications-supa');

const seam: any = SEAM_WIRED ? require('@/lib/applications-supa') : null;
const testFlag = SEAM_WIRED ? test : test.skip;

import { NextRequest } from 'next/server';
import { notificationService } from '@/lib/server/notification-service';
import { deleteChapterWithCleanup } from '@/app/actions/chapter-applications';

// --- Firestore fake (same shape as route-supa.test.ts) ----------------------

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
  deleteChapterWithCleanup: jest.fn(async () => ({ success: true, usersUpdated: 3 })),
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

import { GET, PATCH, DELETE } from '@/app/api/chapter-applications/route';

// --- Adapter fake -----------------------------------------------------------

function makeAdapter(
  store: Map<string, Record<string, any>>,
  faults: { throwOnGet?: boolean } = {},
) {
  const calls = { listDocs: [] as any[], getDoc: [] as any[] };
  const adapter = {
    async getDoc(_collection: string, id: string) {
      calls.getDoc.push(id);
      if (faults.throwOnGet) throw new Error('fake adapter get failure');
      const data = store.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(_collection: string, options: any = {}) {
      calls.listDocs.push(options);
      let docs: Array<Record<string, any>> = Array.from(store.entries()).map(([id, data]) => ({
        id,
        ...data,
      }));
      for (const [field, op, value] of options.where ?? []) {
        if (op === '==') docs = docs.filter((d) => d[field] === value);
      }
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
    headers: { authorization: 'Bearer <redacted>', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  seam?.__resetApplicationsSupaAdapterForTests();
  firestoreState.listDocs = [
    {
      id: 'fs-app-1',
      data: {
        applicantId: 'applicant-fs',
        proposedChapterName: 'Firestore Chapter',
        status: 'pending_review',
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
  (deleteChapterWithCleanup as jest.Mock).mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  seam?.__resetApplicationsSupaAdapterForTests();
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('contracts: /api/chapter-applications unpinned behavior', () => {
  testFlag('PATCH flag ON + adapter error: notification fetch falls back to the Firestore doc', async () => {
    process.env[ENV_KEY] = 'applications';
    const { adapter, calls } = makeAdapter(new Map(), { throwOnGet: true });
    seam.__setApplicationsSupaAdapterForTests(adapter);
    firestoreState.docData = { applicantId: 'applicant-fs-9', proposedChapterName: 'FS Nine' };

    const res = await PATCH(req('PATCH', { applicationId: 'app-9', status: 'rejected' }));
    expect(res.status).toBe(200);
    expect(calls.getDoc).toEqual(['app-9']);
    expect(firestoreState.docCalls).toBe(1);
    expect(notificationService.send).toHaveBeenCalledWith(
      'applicant-fs-9',
      expect.objectContaining({
        type: 'chapter_application',
        body: expect.stringContaining('FS Nine'),
      }),
      'P1',
    );
  });

  testFlag('GET flag ON + empty adapter list: returns [] and never consults Firestore', async () => {
    process.env[ENV_KEY] = 'applications';
    const { adapter, calls } = makeAdapter(new Map());
    seam.__setApplicationsSupaAdapterForTests(adapter);

    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applications: [] });
    expect(calls.listDocs).toHaveLength(1);
    expect(firestoreState.listCalls).toBe(0);
  });

  test('DELETE: success shape delegates to the cleanup action', async () => {
    const res = await DELETE(req('DELETE', { chapterId: 'seds-test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, chapterId: 'seds-test', usersUpdated: 3 });
    expect(deleteChapterWithCleanup).toHaveBeenCalledWith(
      'seds-test',
      'admin-1',
      expect.objectContaining({ consentRequestId: null }),
    );
  });

  test('DELETE: missing chapterId is a 400 and the action is not called', async () => {
    const res = await DELETE(req('DELETE', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('chapterId is required');
    expect(deleteChapterWithCleanup).not.toHaveBeenCalled();
  });
});
