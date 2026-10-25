/**
 * @jest-environment node
 *
 * Batch-mirror tests for the cadetship enrolment in
 * PATCH /api/admin/universal-review (residual of HR gap G1).
 *
 * queueCadetshipEnrolmentInBatch only QUEUES the cadetship write into
 * this route's WriteBatch, so the Supabase mirror cannot be issued
 * from create.ts: this route owns batch.commit(). The route must call
 * mirrorCadetshipSet(cadetshipId, queuedBody) AFTER a successful
 * commit, with the exact body the queue function returned.
 *
 * CONTRACT UNDER TEST:
 * - commit succeeds + cadetships surface flag ON: exactly one
 *   adapter.setDoc('cadetships', cadetshipId, queuedBody), issued
 *   after the commit completed, body carrying the full F.1 shape
 *   serialized for Supa (dates as ISO strings);
 * - batch.commit() FAILS: no mirror call (and no cadetship landed);
 * - cadetships surface flag OFF: no adapter call, approval unchanged
 *   (the seam gates the mirror; the route still calls it);
 * - cadetshipLive OFF: no enrolment is queued, so no mirror call.
 *
 * The Firestore side uses the same in-memory harness style as
 * universal-review-cadetship.test.ts with the REAL create.ts; the
 * Supabase side is the REAL hr-cadetships seam with a fake adapter
 * injected via setAdapterForTests. No live reads.
 */

const mockFlags = { cadetshipLive: true, failCommit: false };
let commitCompleted = false;

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let mockDocs: Record<string, any> = {};
let autoIdCounter = 0;
let committedUpTo = 0;

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function applyValue(existing: any, value: any): any {
  if (isSentinel(value, 'serverTimestamp')) return 'SERVER_TIMESTAMP';
  if (isSentinel(value, 'increment')) return (typeof existing === 'number' ? existing : 0) + value.n;
  if (isSentinel(value, 'arrayUnion')) {
    const base = Array.isArray(existing) ? [...existing] : [];
    for (const v of value.vals) if (!base.includes(v)) base.push(v);
    return base;
  }
  return value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) next[key] = applyValue(next[key], value);
  return next;
}

function applyBatchOps(ops: Array<{ op: string; path: string; data?: any; opts?: any }>): void {
  for (const op of ops) {
    if (op.op === 'set') {
      const base = op.opts?.merge ? (mockDocs[op.path] ?? {}) : {};
      mockDocs[op.path] = applyDataToDoc(base, op.data ?? {});
    } else if (op.op === 'update') {
      mockDocs[op.path] = applyDataToDoc(mockDocs[op.path] ?? {}, op.data ?? {});
    } else if (op.op === 'delete') {
      delete mockDocs[op.path];
    }
  }
}

function makeDocRef(collectionName: string, id?: string): any {
  const docId = id ?? `generated-${++autoIdCounter}`;
  const path = `${collectionName}/${docId}`;
  return {
    id: docId,
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      const base = opts?.merge ? (mockDocs[path] ?? {}) : {};
      mockDocs[path] = applyDataToDoc(base, data ?? {});
    },
    update: async (data: any) => {
      mockDocs[path] = applyDataToDoc(mockDocs[path] ?? {}, data ?? {});
    },
    collection: (sub: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${sub}`, subId),
    }),
  };
}

function makeQuery(collectionName: string, filters: { field: string; op: string; value: any }[], limitN?: number): any {
  return {
    where: (field: string, op: string, value: any) => makeQuery(collectionName, [...filters, { field, op, value }], limitN),
    limit: (n: number) => makeQuery(collectionName, filters, n),
    get: async () => {
      let docs = Object.entries(mockDocs)
        .filter(([path]) => {
          const parts = path.split('/');
          return parts.length === 2 && parts[0] === collectionName;
        })
        .map(([path, data]) => ({
          id: path.split('/')[1],
          data: () => data,
          ref: makeDocRef(collectionName, path.split('/')[1]),
          exists: true,
        }));
      for (const f of filters) {
        docs = docs.filter((d) => {
          const v = d.data()[f.field];
          return f.op === 'in' ? (f.value as any[]).includes(v) : v === f.value;
        });
      }
      if (limitN) docs = docs.slice(0, limitN);
      return { empty: docs.length === 0, docs, forEach: (fn: any) => docs.forEach(fn) };
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => makeDocRef(name, id),
    where: (field: string, op: string, value: any) => makeQuery(name, [{ field, op, value }]),
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => mockBatchOps.push({ op: 'set', path: ref.path, data, opts }),
    update: (ref: any, data: any) => mockBatchOps.push({ op: 'update', path: ref.path, data }),
    delete: (ref: any) => mockBatchOps.push({ op: 'delete', path: ref.path }),
    commit: async () => {
      if (mockFlags.failCommit) throw new Error('simulated batch commit failure');
      applyBatchOps(mockBatchOps.slice(committedUpTo));
      committedUpTo = mockBatchOps.length;
      commitCompleted = true;
    },
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    private payload: any;
    constructor(payload: any, init?: { status?: number }) {
      this.payload = payload;
      this.status = init?.status ?? 200;
    }
    static json(payload: any, init?: { status?: number }) {
      return new MockNextResponse(payload, init);
    }
    async json() {
      return this.payload;
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    // Carries _methodName as the real Admin SDK sentinel does, so the
    // hr-cadetships seam serializer recognizes it as a serverTimestamp.
    serverTimestamp: () => ({ __fv: 'serverTimestamp', _methodName: 'FieldValue.serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  const Timestamp = { fromDate: (d: Date) => ({ toDate: () => d }) };
  return { firestore: { FieldValue, Timestamp } };
});

jest.mock('@/lib/server/leave-return', () => ({
  returnFromLeave: jest.fn(),
  RESTORABLE_TASK_STATUSES: ['pending', 'in_progress', 'in-progress', 'locked'],
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({
    authenticated: true,
    user: {
      userId: 'reviewer-1',
      email: 'reviewer@example.com',
      displayName: 'Reviewer Admin',
      emailVerified: true,
      role: 'admin',
      user: {},
    },
  }),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn().mockResolvedValue(true),
  hasServerPermissionForUser: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/server/governance-settings', () => ({
  isPhase2Live: async (flag: string) => flag === 'cadetshipLive' && mockFlags.cadetshipLive,
}));

import { PATCH } from '../route';
import { fiscalYearOf, cohortIdFor } from '@/lib/server/cadetship/clock';
import {
  resetAdapterForTests,
  setAdapterForTests,
  type SupaAdapter,
} from '@/lib/supa-seams/hr-cadetships';

// ------------------------------------------------------------ fake adapter

const mirrorOrder: { commitCompletedAtMirror: boolean | null } = { commitCompletedAtMirror: null };

function makeAdapter(): SupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => {
      mirrorOrder.commitCompletedAtMirror = commitCompleted;
      return { id, ...data };
    }),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
  };
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;
let adapter: SupaAdapter;

function makeRequest(body: any): any {
  return { json: async () => body };
}

function seedApplication(appId: string, uid: string): void {
  mockDocs[`applications/${appId}`] = {
    userId: uid,
    title: 'Induction Application',
    status: 'pending',
    skills: [],
    chapterId: 'seds-ist-chapter',
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs[`users/${uid}`] = { displayName: 'Applicant', chapterId: 'seds-ist-chapter' };
}

function docsIn(collectionName: string): [string, any][] {
  return Object.entries(mockDocs).filter(([p]) => {
    const parts = p.split('/');
    return parts.length === 2 && parts[0] === collectionName;
  });
}

const approve = (appId: string) => ({ collection: 'applications', ids: [appId], action: 'approve' });

describe('PATCH universal-review cadetship batch mirror (G1 residual)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    commitCompleted = false;
    mirrorOrder.commitCompletedAtMirror = null;
    mockFlags.cadetshipLive = true;
    mockFlags.failCommit = false;
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    adapter = makeAdapter();
    setAdapterForTests(adapter);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    resetAdapterForTests();
    jest.restoreAllMocks();
  });

  test('mirror fires after successful commit with the queued body (both flags ON)', async () => {
    process.env[ENV_KEY] = 'cadetships';
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));
    expect(res.status).toBe(200);

    const stamp = mockDocs['applications/app-1'].cadetshipId;
    expect(typeof stamp).toBe('string');
    expect(mockDocs[`cadetships/${stamp}`]).toBeDefined();

    // Exactly one mirror write, on the cadetships collection only, for
    // the stamped id, issued AFTER the Firestore commit completed.
    expect(adapter.setDoc).toHaveBeenCalledTimes(1);
    expect(mirrorOrder.commitCompletedAtMirror).toBe(true);
    const [collection, id, data] = (adapter.setDoc as jest.Mock).mock.calls[0] as [
      string,
      string,
      Record<string, any>,
    ];
    expect(collection).toBe('cadetships');
    expect(id).toBe(stamp);

    // The queued body, serialized for Supa (dates as ISO strings).
    const fy = fiscalYearOf(new Date());
    expect(data.personUid).toBe('member-1');
    expect(data.applicationId).toBe('app-1');
    expect(data.chapterId).toBe('seds-ist-chapter');
    expect(data.createdVia).toBe('application_approval');
    expect(data.status).toBe('active');
    expect(data.cohortId).toBe(cohortIdFor(fy.fyEndYear, 1));
    expect(data.cohortId).toBe(mockDocs[`cadetships/${stamp}`].cohortId);
    expect(typeof data.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.startedAt))).toBe(false);
    expect(typeof data.probationEnd).toBe('string');
    expect(Date.parse(data.probationEnd)).toBeGreaterThan(Date.parse(data.startedAt));
    expect(typeof data.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.createdAt))).toBe(false);
    expect(data.items.workshops.count).toBe(0);
    expect(data.decision.round).toBe(1);
    expect(data.updatedBy).toBe('system');
  });

  test('batch failure: no mirror call, nothing landed, approval fails', async () => {
    process.env[ENV_KEY] = 'cadetships';
    mockFlags.failCommit = true;
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));

    expect(res.status).toBe(500);
    expect(adapter.setDoc).not.toHaveBeenCalled();
    expect(mirrorOrder.commitCompletedAtMirror).toBeNull();
    expect(mockDocs['applications/app-1'].status).toBe('pending');
    expect(docsIn('cadetships')).toHaveLength(0);
  });

  test('cadetships surface flag OFF: no adapter call, approval unchanged', async () => {
    // SUPA_SURFACES stays unset (deleted in beforeEach): the seam
    // gates mirrorCadetshipSet off, so the adapter never sees a call.
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));

    expect(res.status).toBe(200);
    expect(adapter.setDoc).not.toHaveBeenCalled();
    // Firestore enrolment still landed exactly as before.
    expect(docsIn('cadetships')).toHaveLength(1);
    expect(typeof mockDocs['applications/app-1'].cadetshipId).toBe('string');
  });

  test('cadetshipLive OFF: no enrolment queued, so no mirror call', async () => {
    process.env[ENV_KEY] = 'cadetships';
    mockFlags.cadetshipLive = false;
    seedApplication('app-1', 'member-1');
    const res: any = await PATCH(makeRequest(approve('app-1')));

    expect(res.status).toBe(200);
    expect(mockDocs['applications/app-1'].status).toBe('approved');
    expect(mockDocs['applications/app-1'].cadetshipId).toBeUndefined();
    expect(docsIn('cadetships')).toHaveLength(0);
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });
});
