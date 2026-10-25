/**
 * @jest-environment node
 *
 * GAP-N1 closure — /api/submissions notification writes (x2):
 *   POST  : per-admin batch notifications on a new submission
 *   PATCH : submitter notification on review (approve/reject)
 *
 * Both queued Firestore batch writes with no mirror. They are now
 * mirrored after batch.commit() succeeds via the notifications seam.
 * (mirrorSubmissionReview, also called by PATCH, mirrors the submission
 * / competition / audit docs only — never the notification; verified
 * against src/lib/supa/seam-submissions.ts.)
 *
 * Harness: same in-memory fake Firestore as route.test.ts, extended
 * with the where/limit reads the POST handler performs.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let mockDocs: Record<string, any> = {};
let autoIdCounter = 0;
let committedUpTo = 0;

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function applyValue(existing: any, value: any): any {
  if (isSentinel(value, 'serverTimestamp')) return 'SERVER_TIMESTAMP';
  if (isSentinel(value, 'delete')) return undefined;
  if (isSentinel(value, 'increment')) return (typeof existing === 'number' ? existing : 0) + value.n;
  if (isSentinel(value, 'arrayUnion')) {
    const base = Array.isArray(existing) ? [...existing] : [];
    for (const v of value.vals) {
      if (!base.includes(v)) base.push(v);
    }
    return base;
  }
  return value;
}

function applyDataToDoc(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    const applied = applyValue(next[key], value);
    if (applied === undefined && isSentinel(value, 'delete')) {
      delete next[key];
    } else {
      next[key] = applied;
    }
  }
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
      mockBatchOps.push({ op: 'set', path, data, opts });
    },
    update: async (data: any) => {
      mockBatchOps.push({ op: 'update', path, data });
    },
    delete: async () => {
      mockBatchOps.push({ op: 'delete', path });
    },
    collection: (sub: string) => ({
      doc: (subId?: string) => makeDocRef(`${path}/${sub}`, subId),
    }),
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => makeDocRef(name, id),
    add: async (data: any) => {
      const ref = makeDocRef(name);
      mockBatchOps.push({ op: 'set', path: ref.path, data });
      return ref;
    },
    where: () => ({
      limit: () => ({
        get: async () => {
          if (name === 'roles') {
            return { empty: false, docs: [{ id: 'admin-1' }, { id: 'admin-2' }] };
          }
          return { empty: true, docs: [] };
        },
      }),
    }),
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => {
      mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
    },
    update: (ref: any, data: any) => {
      mockBatchOps.push({ op: 'update', path: ref.path, data });
    },
    delete: (ref: any) => {
      mockBatchOps.push({ op: 'delete', path: ref.path });
    },
    commit: async () => {
      applyBatchOps(mockBatchOps.slice(committedUpTo));
      committedUpTo = mockBatchOps.length;
    },
  }),
};

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number; private payload: any;
    constructor(payload: any, init?: { status?: number }) { this.payload = payload; this.status = init?.status ?? 200; }
    static json(payload: any, init?: { status?: number }) { return new MockNextResponse(payload, init); }
    async json() { return this.payload; }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

jest.mock('firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return {
    firestore: {
      FieldValue,
      Timestamp: { fromDate: (d: Date) => d },
    },
  };
});

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
      role: 'superadmin',
      user: {},
    },
  }),
}));

import { POST, PATCH } from '../route';
import {
  setNotificationsSupaAdapterForTests,
  type NotificationsSupaAdapter,
} from '@/lib/server/notifications-supa-seam';

function makeRequest(body: any): any {
  return { json: async () => body };
}

function makeAdapter(fail = false) {
  const calls = { setDoc: [] as any[], updateDoc: [] as any[], deleteDoc: [] as any[] };
  const adapter: NotificationsSupaAdapter = {
    setDoc: async (...args: any[]) => {
      calls.setDoc.push(args);
      if (fail) throw new Error('supa down');
    },
    updateDoc: async (...args: any[]) => { calls.updateDoc.push(args); },
    deleteDoc: async (...args: any[]) => { calls.deleteDoc.push(args); },
    listDocs: async () => [],
  };
  return { adapter, calls };
}

function notificationSets() {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.includes('/notifications/'));
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockBatchOps.length = 0;
  mockDocs = {};
  autoIdCounter = 0;
  committedUpTo = 0;
  mockDocs['submissions/sub-1'] = {
    userId: 'member-1',
    userDisplayName: 'Member One',
    type: 'resource',
    title: 'Useful Resource',
    url: 'https://example.com/resource',
    status: 'pending',
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs['users/member-1'] = { displayName: 'Member One', points: 0 };
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

describe('GAP-N1: POST /api/submissions admin notifications', () => {
  const POST_BODY = { type: 'resource', title: 'Cool Resource', url: 'https://example.com/cool' };

  it('flag ON: one mirror per admin, with that admin\'s user path and the Firestore doc id', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(makeRequest(POST_BODY));
    expect(res.status).toBe(200);
    const sets = notificationSets();
    expect(sets).toHaveLength(2);
    expect(calls.setDoc).toHaveLength(2);
    for (const set of sets) {
      const [, uid, , notifId] = set.path.split('/');
      const mirror = calls.setDoc.find((c) => c[0] === `users/${uid}/notifications`);
      expect(mirror).toBeDefined();
      expect(mirror[1]).toBe(notifId);
      expect(mirror[2]).toMatchObject({ type: 'submission_pending', title: 'New Submission' });
    }
  });

  it('flag OFF: batch notifications written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const res: any = await POST(makeRequest(POST_BODY));
    expect(res.status).toBe(200);
    expect(notificationSets()).toHaveLength(2);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: POST still succeeds', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await POST(makeRequest(POST_BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

describe('GAP-N1: PATCH /api/submissions submitter notification', () => {
  const APPROVE = { submissionId: 'sub-1', action: 'approve', pointsToAward: 10 };

  it('flag ON: submitter notification mirrored with the submitter path', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(200);
    const sets = notificationSets();
    expect(sets).toHaveLength(1);
    expect(sets[0].path.startsWith('users/member-1/notifications/')).toBe(true);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('users/member-1/notifications');
    expect(calls.setDoc[0][1]).toBe(sets[0].path.split('/').pop());
    expect(calls.setDoc[0][2]).toMatchObject({ type: 'points_awarded' });
  });

  it('flag OFF: notification written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(200);
    expect(notificationSets()).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: PATCH still succeeds with points awarded', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    const res: any = await PATCH(makeRequest(APPROVE));
    expect(res.status).toBe(200);
    expect((await res.json()).pointsAwarded).toBe(10);
  });
});
