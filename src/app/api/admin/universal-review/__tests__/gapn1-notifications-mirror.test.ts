/**
 * @jest-environment node
 *
 * GAP-N1 closure — PATCH /api/admin/universal-review notification
 * writes (x2):
 *   generic approve/reject : batch.set notification to the recipient
 *                            (leave approve exercised here)
 *   leave revoke branch    : direct notifRef.set (leave_revoked)
 *
 * G3 mirrored the reviewed docs (mirrorOps / mirrorUniversalReviewToSupa)
 * but never these notifications. The batch site now queues into
 * notifMirrorOps and flushes after batch.commit(); the revoke site
 * mirrors immediately after its direct set. Harness: same in-memory
 * fake Firestore as universal-review-leave.test.ts.
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
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return { firestore: { FieldValue } };
});

jest.mock('@/lib/server/leave-return', () => ({
  returnFromLeave: jest.fn(async (_db: any, params: any) => {
    const { uid, leaveRequestId, actorId, auditAction, reason } = params;
    const user = mockDocs[`users/${uid}`];
    if (user) {
      user.isOnVacation = false;
      user.vacationMode = false;
      delete user.leaveRequestId;
    }
    const req = mockDocs[`leave_requests/${leaveRequestId}`];
    if (req) {
      req.status = 'completed';
      req.revokedBy = actorId;
      req.revokedAt = 'SERVER_TIMESTAMP';
      if (reason !== undefined) req.revocationReason = reason;
    }
    mockBatchOps.push({
      op: 'set',
      path: `leave_audit/fake-${leaveRequestId}`,
      data: { action: auditAction || 'leave_returned', actorId, targetUid: uid, leaveRequestId },
    });
    return {
      restoredCount: 0,
      heldClearedCount: 0,
      alreadyReturned: false,
      leaveRequestId,
      requestCompleted: true,
      targetUid: uid,
    };
  }),
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

import { PATCH } from '../route';
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

function seedLeave(status = 'pending'): void {
  mockDocs['leave_requests/leave-1'] = {
    userId: 'member-1',
    reason: 'Family emergency',
    startDate: '2026-10-20',
    endDate: '2026-10-24',
    leaveType: 'emergency',
    coveringOfficerId: 'officer-1',
    coveringOfficerName: 'Officer One',
    status,
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs['users/member-1'] = { displayName: 'Member One' };
  mockDocs['users/officer-1'] = { displayName: 'Officer One' };
}

function notificationOps() {
  return mockBatchOps.filter((o) => o.path.includes('/notifications/'));
}

const APPROVE_BODY = { collection: 'leave_requests', ids: ['leave-1'], action: 'approve' };
const REVOKE_BODY = { collection: 'leave_requests', ids: ['leave-1'], action: 'revoke' };

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockBatchOps.length = 0;
  mockDocs = {};
  autoIdCounter = 0;
  committedUpTo = 0;
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setNotificationsSupaAdapterForTests(null);
  jest.restoreAllMocks();
});

describe('GAP-N1: universal-review approve notification (batch site)', () => {
  it('flag ON: recipient notification mirrored after commit', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    seedLeave('pending');
    const res: any = await PATCH(makeRequest(APPROVE_BODY));
    expect(res.status).toBe(200);
    const ops = notificationOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].path.startsWith('users/member-1/notifications/')).toBe(true);
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('users/member-1/notifications');
    expect(calls.setDoc[0][1]).toBe(ops[0].path.split('/').pop());
    expect(calls.setDoc[0][2]).toMatchObject({ type: 'request_approved' });
  });

  it('flag OFF: notification written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    seedLeave('pending');
    const res: any = await PATCH(makeRequest(APPROVE_BODY));
    expect(res.status).toBe(200);
    expect(notificationOps()).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: PATCH still succeeds', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    seedLeave('pending');
    const res: any = await PATCH(makeRequest(APPROVE_BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

describe('GAP-N1: universal-review revoke notification (direct-set site)', () => {
  it('flag ON: leave_revoked notification mirrored with the target user path', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    seedLeave('approved');
    const res: any = await PATCH(makeRequest(REVOKE_BODY));
    expect([200, 207]).toContain(res.status);
    const ops = notificationOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].data.type).toBe('leave_revoked');
    expect(calls.setDoc).toHaveLength(1);
    expect(calls.setDoc[0][0]).toBe('users/member-1/notifications');
    expect(calls.setDoc[0][1]).toBe(ops[0].path.split('/').pop());
    expect(calls.setDoc[0][2]).toMatchObject({ type: 'leave_revoked', title: 'Leave revoked' });
  });

  it('flag OFF: notification written, zero mirror calls', async () => {
    const { adapter, calls } = makeAdapter();
    setNotificationsSupaAdapterForTests(adapter);
    seedLeave('approved');
    const res: any = await PATCH(makeRequest(REVOKE_BODY));
    expect([200, 207]).toContain(res.status);
    expect(notificationOps()).toHaveLength(1);
    expect(calls.setDoc).toHaveLength(0);
  });

  it('mirror failure: revoke response unchanged', async () => {
    const { adapter } = makeAdapter(true);
    setNotificationsSupaAdapterForTests(adapter);
    process.env.SUPA_SURFACES = 'notifications';
    seedLeave('approved');
    const res: any = await PATCH(makeRequest(REVOKE_BODY));
    expect([200, 207]).toContain(res.status);
    const body = await res.json();
    expect(body.results?.[0]?.revoked).toBe(true);
  });
});
