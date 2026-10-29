/**
 * @jest-environment node
 *
 * SEC-RACE (audit item 11): POST /api/induction/submit hasApplied gate.
 *
 * The pre-fix route replaced applications/{uid} unconditionally and
 * forced status:'pending' — a re-POST (direct, bypassing the page's
 * client-side hasApplied guard) overwrote the caller's application
 * and reset a reviewed/decided state back to pending.
 *
 * The gate no longer runs in Firestore. The route calls the seam
 * helper runInductionSubmitGate(uid, applicationData) from
 * '@/lib/applications-supa': ONE Postgres transaction
 * (tx_applications_submit_gate) that takes a per-uid advisory lock,
 * re-reads the priors from fs_applications + fs_users, applies the
 * re-appliable-state rule —
 *   - no stored application (first submission), or
 *   - terminal 'rejected'/'withdrawn' AND fs_users.hasApplied !== true
 *     (the /api/induction/reapply flag clear has run)
 * — and, on allow, upserts fs_applications as the primary write.
 * Anything else denies: the route returns the same 409 body with zero
 * writes to either store. On allow, the route writes the Firestore
 * MIRROR (applications/{uid} set + users/{uid} flag set-merge); if
 * that mirror write throws, the route compensates Supa from the
 * gate's returned priors (priorApp restored via mirrorApplicationSet
 * or deleted via mirrorDeleteDoc; the fs_users flag keys restored
 * via mirrorMergeSetDoc with SUPA_DELETE_FIELD for absent keys) and
 * returns 500. A gate throw is a 500 with zero writes. The route
 * performs NO Firestore reads at all: the firebase-admin fake below
 * makes doc get() and runTransaction() throw, and every test asserts
 * both counters stayed at 0.
 *
 * The fake gate is serialized through a promise chain, emulating the
 * advisory lock, so concurrent submits interleave like production.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/* ------------------------------------------------- seam (Supa) fake */

const mockSupaDeleteField = Symbol('submit-race-fake-delete-field');

function mockClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

const mockSeam = {
  fsApps: new Map<string, Record<string, any>>(),
  fsUsers: new Map<string, Record<string, any>>(),
  gateCalls: [] as Array<{ uid: string; data: any }>,
  gateAppliedWrites: 0,
  gateThrows: false,
  mirrorCalls: [] as Array<{ method: string; args: any[] }>,
  chain: Promise.resolve() as Promise<any>,
};

function mockGateRuleAllows(priorApp: Record<string, any> | null, priorUser: Record<string, any> | null): boolean {
  if (!priorApp) return true;
  const status = typeof priorApp.status === 'string' ? priorApp.status.toLowerCase() : '';
  const terminal = status === 'rejected' || status === 'withdrawn';
  return terminal && priorUser?.hasApplied !== true;
}

const mockRunInductionSubmitGate = jest.fn((uid: string, applicationData: any) => {
  const run = mockSeam.chain.then(async () => {
    mockSeam.gateCalls.push({ uid, data: mockClone(applicationData) });
    if (mockSeam.gateThrows) throw new Error('adapter down');
    const priorApp = mockSeam.fsApps.has(uid) ? mockClone(mockSeam.fsApps.get(uid)!) : null;
    const priorUser = mockSeam.fsUsers.has(uid) ? mockClone(mockSeam.fsUsers.get(uid)!) : null;
    if (!mockGateRuleAllows(priorApp, priorUser)) {
      return {
        outcome: 'already_applied',
        applied: false,
        existingStatus: typeof priorApp?.status === 'string' ? priorApp.status : null,
        priorApp,
        priorUser,
      };
    }
    mockSeam.fsApps.set(uid, mockClone(applicationData));
    mockSeam.gateAppliedWrites += 1;
    return { outcome: 'created', applied: true, existingStatus: null, priorApp, priorUser };
  });
  mockSeam.chain = run.catch(() => undefined);
  return run;
});

function mockMapFor(collection: string): Map<string, Record<string, any>> {
  return collection === 'users' ? mockSeam.fsUsers : mockSeam.fsApps;
}

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: 'user-1', email: 'user1@example.com' },
  }),
}));

jest.mock('@/lib/applications-supa', () => ({
  APPLICATIONS_COLLECTION: 'applications',
  USERS_COLLECTION: 'users',
  SUPA_DELETE_FIELD: mockSupaDeleteField,
  runInductionSubmitGate: mockRunInductionSubmitGate,
  mirrorApplicationSet: async (id: string, data: any) => {
    mockSeam.mirrorCalls.push({ method: 'mirrorApplicationSet', args: [id, mockClone(data)] });
    mockSeam.fsApps.set(id, mockClone(data));
    return true;
  },
  mirrorApplicationUpdate: async (id: string, updates: any) => {
    mockSeam.mirrorCalls.push({ method: 'mirrorApplicationUpdate', args: [id, mockClone(updates)] });
    const existing = mockSeam.fsApps.get(id);
    if (!existing) return false;
    mockSeam.fsApps.set(id, { ...existing, ...mockClone(updates) });
    return true;
  },
  mirrorDeleteDoc: async (collection: string, id: string) => {
    mockSeam.mirrorCalls.push({ method: 'mirrorDeleteDoc', args: [collection, id] });
    mockMapFor(collection).delete(id);
    return true;
  },
  mirrorMergeSetDoc: async (collection: string, id: string, fields: any) => {
    mockSeam.mirrorCalls.push({ method: 'mirrorMergeSetDoc', args: [collection, id, fields] });
    const map = mockMapFor(collection);
    const next: Record<string, any> = { ...(map.get(id) ?? {}) };
    for (const [key, value] of Object.entries(fields)) {
      if (value === mockSupaDeleteField) delete next[key];
      else next[key] = value;
    }
    map.set(id, next);
    return true;
  },
  mirrorInductionFlagClear: async (uid: string) => {
    mockSeam.mirrorCalls.push({ method: 'mirrorInductionFlagClear', args: [uid] });
    const next: Record<string, any> = { ...(mockSeam.fsUsers.get(uid) ?? {}) };
    next.hasApplied = false;
    next.applicationStatus = null;
    next.updatedAt = new Date().toISOString();
    mockSeam.fsUsers.set(uid, next);
    return true;
  },
  setApplicationPrimaryFirst: async () => false,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ST__',
    delete: () => '__DELETE__',
  },
}));

/* ------------------------------------- write-only Firestore fake */
/* get() and runTransaction() are hard-forbidden: the new route must
 * perform zero Firestore reads. They count and throw if touched. */

const mockFsDocs: Record<string, any> = {};
const mockAuditAdds: any[] = [];
const mockFsCounters = { writes: 0, appWrites: 0 };
const mockFsControl = { failAppSet: false };

const mockForbiddenGet = jest.fn(async (): Promise<any> => {
  throw new Error('Firestore get() must not be called by the submit route');
});
const mockForbiddenRunTransaction = jest.fn(async (): Promise<any> => {
  throw new Error('Firestore runTransaction() must not be called by the submit route');
});

function mockApplySet(path: string, data: any, opts?: any) {
  if (opts?.merge) {
    const next = { ...(mockFsDocs[path] ?? {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v === '__DELETE__') delete next[k];
      else next[k] = v;
    }
    mockFsDocs[path] = next;
  } else {
    mockFsDocs[path] = { ...data };
  }
}

function mockMakeDocRef(collectionName: string, id: string): any {
  const path = `${collectionName}/${id}`;
  return {
    id,
    path,
    get: mockForbiddenGet,
    set: async (data: any, opts?: any) => {
      if (mockFsControl.failAppSet && path === 'applications/user-1') {
        throw new Error('Firestore mirror write failed');
      }
      mockFsCounters.writes += 1;
      if (path.startsWith('applications/')) mockFsCounters.appWrites += 1;
      mockApplySet(path, data, opts);
    },
    update: async (data: any) => {
      mockFsCounters.writes += 1;
      mockApplySet(path, data, { merge: true });
    },
    delete: async () => {
      mockFsCounters.writes += 1;
      delete mockFsDocs[path];
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => mockMakeDocRef(name, id),
    add: async (data: any) => {
      mockAuditAdds.push(data);
      return { id: 'audit-1' };
    },
  }),
  runTransaction: mockForbiddenRunTransaction,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

import { POST } from '../submit/route';

function makeRequest(applicationData: any): any {
  return { json: async () => ({ applicationData }) };
}

const form = { fullName: 'User One', intakeWindowId: 'w-2026' };

function expectNoFirestoreReads() {
  expect(mockForbiddenGet).not.toHaveBeenCalled();
  expect(mockForbiddenRunTransaction).not.toHaveBeenCalled();
}

describe('POST /api/induction/submit hasApplied gate (SEC-RACE item 11)', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockFsDocs)) delete mockFsDocs[k];
    mockAuditAdds.length = 0;
    mockFsCounters.writes = 0;
    mockFsCounters.appWrites = 0;
    mockFsControl.failAppSet = false;
    mockForbiddenGet.mockClear();
    mockForbiddenRunTransaction.mockClear();
    mockSeam.fsApps.clear();
    mockSeam.fsUsers.clear();
    mockSeam.gateCalls = [];
    mockSeam.gateAppliedWrites = 0;
    mockSeam.gateThrows = false;
    mockSeam.mirrorCalls = [];
    mockSeam.chain = Promise.resolve();
    mockRunInductionSubmitGate.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (console.error as jest.Mock).mockRestore?.();
    (console.warn as jest.Mock).mockRestore?.();
  });

  test('first submission succeeds; after a review decision a re-POST is 409 and preserves the decided application in both stores', async () => {
    const first: any = await POST(makeRequest(form));
    expect(first.status).toBe(200);
    expect(mockSeam.fsApps.get('user-1')?.status).toBe('pending');
    expect(mockFsDocs['applications/user-1'].status).toBe('pending');
    expect(mockFsDocs['users/user-1'].hasApplied).toBe(true);

    // Simulate a review decision landing in BOTH stores after the
    // first submission.
    mockSeam.fsApps.set('user-1', {
      ...mockSeam.fsApps.get('user-1'),
      status: 'approved',
      reviewed_by: 'admin-9',
      pre_score: 88,
    });
    mockFsDocs['applications/user-1'] = {
      ...mockFsDocs['applications/user-1'],
      status: 'approved',
      reviewed_by: 'admin-9',
      pre_score: 88,
    };

    const second: any = await POST(makeRequest({ fullName: 'Overwrite Attempt' }));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe('ALREADY_APPLIED');
    expect(body.existingStatus).toBe('approved');
    // The decided application is untouched in both stores: no reset
    // to pending, no field overwrite, no second audit entry, and
    // exactly one gate-applied write across both submissions.
    expect(mockSeam.fsApps.get('user-1')?.status).toBe('approved');
    expect(mockSeam.fsApps.get('user-1')?.fullName).toBe('User One');
    expect(mockSeam.fsApps.get('user-1')?.reviewed_by).toBe('admin-9');
    expect(mockFsDocs['applications/user-1'].status).toBe('approved');
    expect(mockFsDocs['applications/user-1'].fullName).toBe('User One');
    expect(mockFsDocs['applications/user-1'].reviewed_by).toBe('admin-9');
    expect(mockAuditAdds).toHaveLength(1);
    expect(mockSeam.gateAppliedWrites).toBe(1);
    expectNoFirestoreReads();
  });

  test('two concurrent submits: exactly one lands (200), the other is 409, one application in each store', async () => {
    const [r1, r2]: any[] = await Promise.all([POST(makeRequest(form)), POST(makeRequest(form))]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(mockSeam.fsApps.size).toBe(1);
    expect(mockSeam.fsApps.get('user-1')?.status).toBe('pending');
    expect(mockFsDocs['applications/user-1'].status).toBe('pending');
    expect(mockFsCounters.appWrites).toBe(1);
    expect(mockFsDocs['users/user-1'].hasApplied).toBe(true);
    expect(mockSeam.gateAppliedWrites).toBe(1);
    expect(mockAuditAdds).toHaveLength(1);
    expectNoFirestoreReads();
  });

  test('a pending/under_review application blocks a re-POST with zero writes', async () => {
    mockSeam.fsApps.set('user-1', { uid: 'user-1', status: 'under_review', fullName: 'Original' });
    mockSeam.fsUsers.set('user-1', { hasApplied: true, applicationStatus: 'under_review' });
    mockFsDocs['applications/user-1'] = { uid: 'user-1', status: 'under_review', fullName: 'Original' };
    mockFsDocs['users/user-1'] = { hasApplied: true, applicationStatus: 'under_review' };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(409);
    expect(mockSeam.fsApps.get('user-1')?.fullName).toBe('Original');
    expect(mockFsDocs['applications/user-1'].fullName).toBe('Original');
    expect(mockFsCounters.writes).toBe(0);
    expect(mockSeam.gateAppliedWrites).toBe(0);
    expect(mockSeam.mirrorCalls).toHaveLength(0);
    expect(mockAuditAdds).toHaveLength(0);
    expectNoFirestoreReads();
  });

  test('rejected application with fs_users.hasApplied still true is blocked (409)', async () => {
    mockSeam.fsApps.set('user-1', { uid: 'user-1', status: 'rejected', fullName: 'Original' });
    mockSeam.fsUsers.set('user-1', { hasApplied: true, applicationStatus: 'rejected' });
    mockFsDocs['applications/user-1'] = { uid: 'user-1', status: 'rejected', fullName: 'Original' };
    mockFsDocs['users/user-1'] = { hasApplied: true, applicationStatus: 'rejected' };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPLIED');
    expect(mockSeam.fsApps.get('user-1')?.status).toBe('rejected');
    expect(mockFsDocs['applications/user-1'].status).toBe('rejected');
    expect(mockFsCounters.writes).toBe(0);
    expect(mockSeam.gateAppliedWrites).toBe(0);
    expectNoFirestoreReads();
  });

  test('rejected application AFTER the re-apply flag clear may submit fresh (200)', async () => {
    mockSeam.fsApps.set('user-1', { uid: 'user-1', status: 'rejected', fullName: 'Original' });
    // Exactly the state POST /api/induction/reapply leaves behind.
    mockSeam.fsUsers.set('user-1', { hasApplied: false, applicationStatus: null });
    mockFsDocs['applications/user-1'] = { uid: 'user-1', status: 'rejected', fullName: 'Original' };
    mockFsDocs['users/user-1'] = { hasApplied: false, applicationStatus: null };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(200);
    expect(mockSeam.fsApps.get('user-1')?.status).toBe('pending');
    expect(mockSeam.fsApps.get('user-1')?.fullName).toBe('User One');
    expect(mockFsDocs['applications/user-1'].status).toBe('pending');
    expect(mockFsDocs['applications/user-1'].fullName).toBe('User One');
    expect(mockFsDocs['users/user-1'].hasApplied).toBe(true);
    expect(mockFsDocs['users/user-1'].applicationStatus).toBe('pending');
    expect(mockSeam.gateAppliedWrites).toBe(1);
    expectNoFirestoreReads();
  });

  test('gate deny: zero Firestore writes and zero mirror calls', async () => {
    mockSeam.fsApps.set('user-1', { uid: 'user-1', status: 'pending', fullName: 'Original' });
    mockSeam.fsUsers.set('user-1', { hasApplied: true, applicationStatus: 'pending' });
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error:
        'You have already submitted an application. It cannot be replaced while it is under review or decided.',
      code: 'ALREADY_APPLIED',
      existingStatus: 'pending',
    });
    expect(mockRunInductionSubmitGate).toHaveBeenCalledTimes(1);
    expect(mockSeam.gateAppliedWrites).toBe(0);
    expect(mockFsCounters.writes).toBe(0);
    expect(mockSeam.mirrorCalls).toHaveLength(0);
    expect(mockAuditAdds).toHaveLength(0);
    expect(mockFsDocs['applications/user-1']).toBeUndefined();
    expectNoFirestoreReads();
  });

  test('Firestore mirror failure after the gate applied: 500, Supa compensated from the priors (no-prior row deleted), no audit', async () => {
    mockFsControl.failAppSet = true;
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Submission failed');
    // The gate DID apply its write before the mirror failed...
    expect(mockSeam.gateAppliedWrites).toBe(1);
    // ...and compensation removed it again: with no prior application
    // the rollback is a delete of the fs_applications row.
    expect(mockSeam.fsApps.has('user-1')).toBe(false);
    const deleteCalls = mockSeam.mirrorCalls.filter((c) => c.method === 'mirrorDeleteDoc');
    expect(deleteCalls).toEqual([{ method: 'mirrorDeleteDoc', args: ['applications', 'user-1'] }]);
    // The fs_users flag keys were restored via a merge-set carrying
    // the fake SUPA_DELETE_FIELD for every (absent) prior key.
    const flagRestores = mockSeam.mirrorCalls.filter((c) => c.method === 'mirrorMergeSetDoc');
    expect(flagRestores).toHaveLength(1);
    expect(flagRestores[0].args[0]).toBe('users');
    expect(flagRestores[0].args[1]).toBe('user-1');
    expect(flagRestores[0].args[2].hasApplied).toBe(mockSupaDeleteField);
    expect(flagRestores[0].args[2].applicationStatus).toBe(mockSupaDeleteField);
    expect(mockFsDocs['applications/user-1']).toBeUndefined();
    expect(mockAuditAdds).toHaveLength(0);
    expectNoFirestoreReads();
  });

  test('gate throws (adapter down): 500 with zero writes in both stores', async () => {
    mockSeam.gateThrows = true;
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Submission failed');
    expect(mockSeam.fsApps.size).toBe(0);
    expect(mockSeam.gateAppliedWrites).toBe(0);
    expect(mockSeam.mirrorCalls).toHaveLength(0);
    expect(mockFsCounters.writes).toBe(0);
    expect(mockFsDocs['applications/user-1']).toBeUndefined();
    expect(mockFsDocs['users/user-1']).toBeUndefined();
    expect(mockAuditAdds).toHaveLength(0);
    expectNoFirestoreReads();
  });

  test('static pin: the submit route source performs no Firestore reads', () => {
    const src = readFileSync(join(__dirname, '../submit/route.ts'), 'utf8');
    expect(src).not.toMatch(/runTransaction/);
    expect(src).not.toMatch(/\.get\(/);
    expect(src).not.toMatch(/getDocs/);
    expect(src).not.toMatch(/onSnapshot/);
    expectNoFirestoreReads();
  });
});
