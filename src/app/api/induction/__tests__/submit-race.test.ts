/**
 * @jest-environment node
 *
 * SEC-RACE (audit item 11): POST /api/induction/submit hasApplied gate.
 *
 * The pre-fix route replaced applications/{uid} unconditionally and
 * forced status:'pending' — a re-POST (direct, bypassing the page's
 * client-side hasApplied guard) overwrote the caller's application
 * and reset a reviewed/decided state back to pending. The route now
 * runs a gate runTransaction that re-reads the stored application +
 * user flags and writes only from a re-appliable state:
 *   - no stored application (first submission), or
 *   - terminal 'rejected'/'withdrawn' AND hasApplied flag cleared
 *     (the /api/induction/reapply flow has run).
 * Anything else is a 409 with zero writes to either store.
 *
 * The fake's runTransaction is serialized through a promise chain,
 * so concurrent submits interleave like production.
 */

const seamState = {
  primary: false,
  primaryThrows: false,
  seamSets: [] as Array<{ id: string; data: any }>,
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: { userId: 'user-1', email: 'user1@example.com' },
  }),
}));

jest.mock('@/lib/applications-supa', () => ({
  setApplicationPrimaryFirst: async (id: string, data: any) => {
    if (seamState.primaryThrows) throw new Error('adapter down');
    if (!seamState.primary) return false;
    seamState.seamSets.push({ id, data });
    return true;
  },
  mirrorApplicationSet: async (id: string, data: any) => {
    seamState.seamSets.push({ id, data });
    return true;
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ST__',
    delete: () => '__DELETE__',
  },
}));

/* ------------------------------------------------ in-memory Firestore */
const mockDocs: Record<string, any> = {};
const auditAdds: any[] = [];
let appWriteCount = 0;
let txChain: Promise<any> = Promise.resolve();

function applySet(path: string, data: any, opts?: any) {
  if (path.startsWith('applications/')) appWriteCount += 1;
  if (opts?.merge) {
    const next = { ...(mockDocs[path] ?? {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v === '__DELETE__') delete next[k];
      else next[k] = v;
    }
    mockDocs[path] = next;
  } else {
    mockDocs[path] = { ...data };
  }
}

function makeDocRef(collectionName: string, id: string): any {
  const path = `${collectionName}/${id}`;
  return {
    id,
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => applySet(path, data, opts),
    update: async (data: any) => applySet(path, data, { merge: true }),
    delete: async () => {
      delete mockDocs[path];
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => makeDocRef(name, id),
    add: async (data: any) => {
      auditAdds.push(data);
      return { id: 'audit-1' };
    },
  }),
  runTransaction: (fn: any) => {
    const run = txChain.then(async () => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => applySet(ref.path, data, opts),
        update: async (ref: any, data: any) => applySet(ref.path, data, { merge: true }),
        delete: async (ref: any) => {
          delete mockDocs[ref.path];
        },
      };
      return fn(tx);
    });
    txChain = run.catch(() => undefined);
    return run;
  },
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

describe('POST /api/induction/submit hasApplied gate (SEC-RACE item 11)', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDocs)) delete mockDocs[k];
    auditAdds.length = 0;
    appWriteCount = 0;
    txChain = Promise.resolve();
    seamState.primary = false;
    seamState.primaryThrows = false;
    seamState.seamSets = [];
  });

  test('first submission succeeds; a sequential re-POST is 409 and preserves the application', async () => {
    const first: any = await POST(makeRequest(form));
    expect(first.status).toBe(200);
    expect(mockDocs['applications/user-1'].status).toBe('pending');

    // Simulate a review decision landing after the first submission.
    mockDocs['applications/user-1'] = {
      ...mockDocs['applications/user-1'],
      status: 'approved',
      reviewed_by: 'admin-9',
      pre_score: 88,
    };

    const second: any = await POST(makeRequest({ fullName: 'Overwrite Attempt' }));
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('ALREADY_APPLIED');
    // The decided application is untouched: no reset to pending, no
    // field overwrite, no second audit entry, no Supa write.
    expect(mockDocs['applications/user-1'].status).toBe('approved');
    expect(mockDocs['applications/user-1'].fullName).toBe('User One');
    expect(mockDocs['applications/user-1'].reviewed_by).toBe('admin-9');
    expect(auditAdds).toHaveLength(1);
    expect(seamState.seamSets).toHaveLength(1);
  });

  test('two concurrent submits: exactly one lands, the other is 409', async () => {
    const [r1, r2]: any[] = await Promise.all([POST(makeRequest(form)), POST(makeRequest(form))]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(mockDocs['applications/user-1'].status).toBe('pending');
    expect(mockDocs['users/user-1'].hasApplied).toBe(true);
    expect(appWriteCount).toBe(1);
    expect(auditAdds).toHaveLength(1);
    expect(seamState.seamSets).toHaveLength(1);
  });

  test('a pending (in-review) application blocks a re-POST', async () => {
    mockDocs['applications/user-1'] = { uid: 'user-1', status: 'under_review', fullName: 'Original' };
    mockDocs['users/user-1'] = { hasApplied: true, applicationStatus: 'under_review' };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(409);
    expect(mockDocs['applications/user-1'].fullName).toBe('Original');
    expect(appWriteCount).toBe(0);
    expect(seamState.seamSets).toHaveLength(0);
  });

  test('rejected application WITHOUT the re-apply flag clear is still blocked', async () => {
    mockDocs['applications/user-1'] = { uid: 'user-1', status: 'rejected', fullName: 'Original' };
    mockDocs['users/user-1'] = { hasApplied: true, applicationStatus: 'rejected' };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(409);
    expect(mockDocs['applications/user-1'].status).toBe('rejected');
    expect(appWriteCount).toBe(0);
  });

  test('rejected application AFTER the re-apply flag clear may submit fresh', async () => {
    mockDocs['applications/user-1'] = { uid: 'user-1', status: 'rejected', fullName: 'Original' };
    // Exactly the state POST /api/induction/reapply leaves behind.
    mockDocs['users/user-1'] = { hasApplied: false, applicationStatus: null };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(200);
    expect(mockDocs['applications/user-1'].status).toBe('pending');
    expect(mockDocs['applications/user-1'].fullName).toBe('User One');
    expect(mockDocs['users/user-1'].hasApplied).toBe(true);
    expect(mockDocs['users/user-1'].applicationStatus).toBe('pending');
  });

  test('primacy leg: the gate runs before the Supa write — a live application means zero seam writes', async () => {
    seamState.primary = true;
    mockDocs['applications/user-1'] = { uid: 'user-1', status: 'shortlisted', fullName: 'Original' };
    mockDocs['users/user-1'] = { hasApplied: true, applicationStatus: 'shortlisted' };
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(409);
    expect(seamState.seamSets).toHaveLength(0);
    expect(mockDocs['applications/user-1'].status).toBe('shortlisted');
  });

  test('primacy leg: adapter failure after the gate is compensated — no submission survives', async () => {
    seamState.primary = true;
    seamState.primaryThrows = true;
    const res: any = await POST(makeRequest(form));
    expect(res.status).toBe(500);
    expect(mockDocs['applications/user-1']).toBeUndefined();
    expect(mockDocs['users/user-1']).toBeUndefined();
  });
});
