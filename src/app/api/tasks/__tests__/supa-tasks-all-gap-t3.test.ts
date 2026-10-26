/**
 * @jest-environment node
 *
 * GAP-T3-01 pins for GET /api/tasks/all (feat/supa-cut-tasks).
 * Mocked adapter + mocked Firestore — zero live reads.
 *
 * The ratified ON-path semantics (route header):
 * - flag OFF / adapter absent -> 404 (the OFF observable contract).
 * - limit defaults to 500, explicit values floored, capped at 2000,
 *   and forwarded to the seam; the seam REQUIRES an explicit limit
 *   (listAllTaskDocs throws TASKS_ALL_LIMIT_REQUIRED without one), so
 *   truncation at the stated bound is a contract, never silent.
 * - seam read failure -> bounded Firestore fallback with the SAME
 *   limit and the same response shape { tasks, limit }.
 * - seam AND fallback both fail -> 500 { error }.
 */

const mockVerifyAuthentication = jest.fn();
const mockHasPermission = jest.fn(async (..._args: any[]) => true);

let fallbackDocs: any[] = [];
let fallbackError: Error | null = null;
let capturedFallbackLimit: number | null = null;

const mockDb: any = {
  collection: (_name: string) => ({
    limit: (n: number) => ({
      get: async () => {
        capturedFallbackLimit = n;
        if (fallbackError) throw fallbackError;
        return { docs: fallbackDocs };
      },
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __increment: n }) } } },
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: any[]) => mockVerifyAuthentication(...args),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: (...args: any[]) => mockHasPermission(...args),
}));

import { GET as allGET } from '@/app/api/tasks/all/route';
import {
  __setAdminTasksSupaAdapterForTests,
  __resetAdminTasksSupaAdapterForTests,
  listAllTaskDocs,
  type AdminTasksSupaAdapter,
} from '@/lib/supa/seam-admin-tasks';

function req(url: string): any {
  return { url, json: async () => ({}), headers: new Headers() };
}

function makeAdapter(overrides: Partial<AdminTasksSupaAdapter> = {}): AdminTasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({})),
    updateDoc: jest.fn(async () => ({})),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  } as AdminTasksSupaAdapter;
}

beforeEach(() => {
  jest.clearAllMocks();
  fallbackDocs = [];
  fallbackError = null;
  capturedFallbackLimit = null;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockVerifyAuthentication.mockResolvedValue({
    authenticated: true,
    user: { user: { uid: 'admin-1', permissions: { manageTasks: true } } },
  });
});

afterEach(() => {
  __resetAdminTasksSupaAdapterForTests();
  jest.restoreAllMocks();
});

describe('GAP-T3-01 /api/tasks/all semantics', () => {
  it('flag OFF: 404, no adapter or Firestore read', async () => {
    __setAdminTasksSupaAdapterForTests(null);
    const res = await allGET(req('http://x/api/tasks/all'));
    expect(res.status).toBe(404);
    expect(capturedFallbackLimit).toBeNull();
  });

  it('ON: forwards the default limit 500 to the seam', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => [{ id: 't1', title: 'A', createdAt: '2026-10-25T00:00:00.000Z' }]),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    const res = await allGET(req('http://x/api/tasks/all'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(500);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('t1');
    expect((adapter.listDocs as jest.Mock).mock.calls[0][1]).toEqual({ limit: 500 });
  });

  it('ON: an explicit limit is floored and capped at 2000', async () => {
    const adapter = makeAdapter();
    __setAdminTasksSupaAdapterForTests(adapter);
    const res = await allGET(req('http://x/api/tasks/all?limit=99999'));
    expect(res.status).toBe(200);
    expect((await res.json()).limit).toBe(2000);
    expect((adapter.listDocs as jest.Mock).mock.calls[0][1]).toEqual({ limit: 2000 });
  });

  it('ON seam failure: bounded Firestore fallback with the SAME limit and shape', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => {
        throw new Error('seam down');
      }),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    fallbackDocs = [{ id: 'f1', data: () => ({ title: 'Fallback' }) }];
    const res = await allGET(req('http://x/api/tasks/all?limit=7'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(7);
    expect(body.tasks).toEqual([{ id: 'f1', title: 'Fallback' }]);
    expect(capturedFallbackLimit).toBe(7);
  });

  it('ON seam + fallback both fail: 500 { error } (no unbounded path exists)', async () => {
    const adapter = makeAdapter({
      listDocs: jest.fn(async () => {
        throw new Error('seam down');
      }),
    });
    __setAdminTasksSupaAdapterForTests(adapter);
    fallbackError = new Error('firestore down');
    const res = await allGET(req('http://x/api/tasks/all'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('firestore down');
  });
});

describe('GAP-T3-01 seam fail-loud', () => {
  it('listAllTaskDocs without a limit throws TASKS_ALL_LIMIT_REQUIRED and reads nothing', async () => {
    const adapter = makeAdapter();
    await expect(listAllTaskDocs(adapter)).rejects.toThrow(/TASKS_ALL_LIMIT_REQUIRED/);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });

  it('listAllTaskDocs rejects non-positive limits', async () => {
    const adapter = makeAdapter();
    await expect(listAllTaskDocs(adapter, 0)).rejects.toThrow(/positive number/);
    await expect(listAllTaskDocs(adapter, -3)).rejects.toThrow(/positive number/);
    expect(adapter.listDocs).not.toHaveBeenCalled();
  });
});
