/**
 * Slice 16: tests for the leave branch of PATCH /api/admin/universal-review.
 *
 * DROP-IN LOCATION: src/app/api/admin/universal-review/__tests__/universal-review-leave.test.ts
 * (this file is delivered as .txt so it does not run in the repo before the
 * implementation slice lands; rename it to .ts to run it).
 *
 * CONTRACT UNDER TEST (from IS_ON_VACATION_ADAPTATION_GUIDE.md Step 2 plus the
 * revoke decision in the slice brief):
 * - approve on a pending leave_requests doc sets isOnVacation AND vacationMode
 *   true, coveringOfficerId, vacationStartDate, vacationEndDate and
 *   leaveRequestId on users/{requesterUid}, and writes one leave_audit doc
 *   with action 'leave_approved'.
 * - approving an already approved (or rejected) leave is a no-op: no new
 *   batch ops, no duplicate audit, flags untouched.
 * - reject sets no vacation flags on the user doc.
 * - approve with no covering officer sets the flags with coveringOfficerId
 *   null (audit included).
 * - leave approval NEVER awards points and NEVER writes points_ledger, even
 *   when the request body carries a points value.
 * - revoke on an approved leave clears the flags, clears leaveRequestId,
 *   marks the request 'completed', and writes one leave_audit doc with
 *   action 'leave_revoked'. Revoke is a new action: the current route maps
 *   every non-approve action to 'rejected', so the implementation must add
 *   an explicit revoke branch before that mapping.
 *
 * PATTERN: follows src/app/api/tasks/__tests__/route.step-resources.test.ts -
 * the real PATCH export is exercised with a fully mocked Firestore, and the
 * mock batch commit applies ops to in-memory docs so a second approve reads
 * the already-approved state, exactly like production.
 */

const mockBatchOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let mockDocs: Record<string, any> = {};
let autoIdCounter = 0;
let committedUpTo = 0;
let txChain: Promise<any> = Promise.resolve();

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
  // SEC-RACE: the route now claims points awards inside
  // runTransaction. Serialized like production: tx writes apply
  // immediately to mockDocs and are recorded as already-committed
  // ops so a later batch commit never re-applies them.
  runTransaction: (fn: any) => {
    const run = txChain.then(async () => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: async (ref: any, data: any, opts?: any) => {
          const base = opts?.merge ? (mockDocs[ref.path] ?? {}) : {};
          mockDocs[ref.path] = applyDataToDoc(base, data ?? {});
          mockBatchOps.push({ op: 'set', path: ref.path, data, opts });
          committedUpTo = mockBatchOps.length;
        },
        update: async (ref: any, data: any) => {
          mockDocs[ref.path] = applyDataToDoc(mockDocs[ref.path] ?? {}, data ?? {});
          mockBatchOps.push({ op: 'update', path: ref.path, data });
          committedUpTo = mockBatchOps.length;
        },
      };
      return fn(tx);
    });
    txChain = run.catch(() => undefined);
    return run;
  },
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
  // Coordinator note: the real helper is covered by the return-ui suite
  // (Slice 18). Here it is faked so the revoke branch can be tested
  // without a full Firestore mock: it clears the flags, completes the
  // request, and records one leave_revoked audit op.
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
      ref: { path: `leave_audit/fake-${leaveRequestId}` },
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

function makeRequest(body: any): any {
  return { json: async () => body };
}

function seedLeave(overrides: Record<string, any> = {}): void {
  mockDocs['leave_requests/leave-1'] = {
    userId: 'member-1',
    reason: 'Family emergency',
    startDate: '2026-10-20',
    endDate: '2026-10-24',
    leaveType: 'emergency',
    coveringOfficerId: 'officer-1',
    coveringOfficerName: 'Officer One',
    status: 'pending',
    ...overrides,
  };
  mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
  mockDocs['users/member-1'] = { displayName: 'Member One' };
  mockDocs['users/officer-1'] = { displayName: 'Officer One' };
}

function seedApprovedLeave(): void {
  seedLeave({ status: 'approved' });
  mockDocs['users/member-1'] = {
    displayName: 'Member One',
    isOnVacation: true,
    vacationMode: true,
    coveringOfficerId: 'officer-1',
    vacationStartDate: '2026-10-20',
    vacationEndDate: '2026-10-24',
    leaveRequestId: 'leave-1',
  };
}

function opsOn(path: string): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.path === path);
}

function auditSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.startsWith('leave_audit/'));
}

function ledgerSets(): Array<{ op: string; path: string; data?: any; opts?: any }> {
  return mockBatchOps.filter((o) => o.op === 'set' && o.path.startsWith('points_ledger/'));
}

const APPROVE_BODY = { collection: 'leave_requests', ids: ['leave-1'], action: 'approve' };
const REJECT_BODY = { collection: 'leave_requests', ids: ['leave-1'], action: 'reject' };
const REVOKE_BODY = { collection: 'leave_requests', ids: ['leave-1'], action: 'revoke' };

describe('PATCH /api/admin/universal-review leave branch', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    txChain = Promise.resolve();
  });

  test('approve sets isOnVacation and vacationMode true on the requester user doc', async () => {
    seedLeave();
    const res: any = await PATCH(makeRequest(APPROVE_BODY));
    expect(res.status).toBe(200);
    const user = mockDocs['users/member-1'];
    expect(user.isOnVacation).toBe(true);
    expect(user.vacationMode).toBe(true);
  });

  test('approve sets coveringOfficerId from the leave request', async () => {
    seedLeave();
    await PATCH(makeRequest(APPROVE_BODY));
    expect(mockDocs['users/member-1'].coveringOfficerId).toBe('officer-1');
  });

  test('approve sets vacationStartDate and vacationEndDate from the leave request dates', async () => {
    seedLeave();
    await PATCH(makeRequest(APPROVE_BODY));
    const user = mockDocs['users/member-1'];
    expect(user.vacationStartDate).toBe('2026-10-20');
    expect(user.vacationEndDate).toBe('2026-10-24');
  });

  test('approve sets leaveRequestId to the leave request id', async () => {
    seedLeave();
    await PATCH(makeRequest(APPROVE_BODY));
    expect(mockDocs['users/member-1'].leaveRequestId).toBe('leave-1');
  });

  test('approve writes a leave_audit doc with action leave_approved and the reviewer as actor', async () => {
    seedLeave();
    await PATCH(makeRequest(APPROVE_BODY));
    const audits = auditSets();
    expect(audits).toHaveLength(1);
    const audit = audits[0].data;
    expect(audit.action).toBe('leave_approved');
    expect(audit.actorId).toBe('reviewer-1');
    expect(audit.targetUid).toBe('member-1');
    expect(audit.leaveRequestId).toBe('leave-1');
    expect(audit.startDate).toBe('2026-10-20');
    expect(audit.endDate).toBe('2026-10-24');
    expect(audit.coveringOfficerId).toBe('officer-1');
    expect(audit.timestamp).toBeDefined();
  });

  test('approve flips the leave request status to approved with reviewer stamps', async () => {
    seedLeave();
    await PATCH(makeRequest(APPROVE_BODY));
    const doc = mockDocs['leave_requests/leave-1'];
    expect(doc.status).toBe('approved');
    expect(doc.reviewedBy).toBe('reviewer-1');
    expect(doc.reviewedAt).toBeDefined();
  });

  test('second approve is a no-op with no duplicate audit and no flag rewrite', async () => {
    seedLeave();
    const first: any = await PATCH(makeRequest(APPROVE_BODY));
    expect(first.status).toBe(200);
    const opsAfterFirst = mockBatchOps.length;
    expect(auditSets()).toHaveLength(1);

    const second: any = await PATCH(makeRequest(APPROVE_BODY));
    expect(second.status).toBe(200);
    const secondCallOps = mockBatchOps.slice(opsAfterFirst);
    expect(secondCallOps).toHaveLength(0);
    expect(auditSets()).toHaveLength(1);
    const user = mockDocs['users/member-1'];
    expect(user.isOnVacation).toBe(true);
    expect(user.vacationMode).toBe(true);
    expect(user.coveringOfficerId).toBe('officer-1');
  });

  test('approve with no covering officer sets coveringOfficerId to null and still sets the flags', async () => {
    seedLeave();
    delete mockDocs['leave_requests/leave-1'].coveringOfficerId;
    delete mockDocs['leave_requests/leave-1'].coveringOfficerName;
    await PATCH(makeRequest(APPROVE_BODY));
    const user = mockDocs['users/member-1'];
    expect(user.isOnVacation).toBe(true);
    expect(user.vacationMode).toBe(true);
    expect(user.coveringOfficerId).toBeNull();
    expect(user.leaveRequestId).toBe('leave-1');
  });

  test('approve with no covering officer writes leave_audit with coveringOfficerId null', async () => {
    seedLeave();
    delete mockDocs['leave_requests/leave-1'].coveringOfficerId;
    delete mockDocs['leave_requests/leave-1'].coveringOfficerName;
    await PATCH(makeRequest(APPROVE_BODY));
    const audits = auditSets();
    expect(audits).toHaveLength(1);
    expect(audits[0].data.coveringOfficerId).toBeNull();
    expect(audits[0].data.action).toBe('leave_approved');
  });

  test('approve awards no points and writes no points_ledger entry even when points are passed', async () => {
    seedLeave();
    const res: any = await PATCH(makeRequest({ ...APPROVE_BODY, points: 50 }));
    expect(res.status).toBe(200);
    expect(ledgerSets()).toHaveLength(0);
    const userOps = opsOn('users/member-1');
    for (const op of userOps) {
      expect(op.data).not.toHaveProperty('total_points');
      expect(op.data).not.toHaveProperty('points');
    }
    expect(mockDocs['users/member-1']).not.toHaveProperty('total_points');
    // Approval itself still succeeds and still sets the flags.
    expect(mockDocs['users/member-1'].isOnVacation).toBe(true);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('approved');
  });

  test('approve with no points in the body writes no points_ledger entry', async () => {
    seedLeave();
    await PATCH(makeRequest(APPROVE_BODY));
    expect(ledgerSets()).toHaveLength(0);
  });

  test('reject sets no vacation flags on the requester user doc', async () => {
    seedLeave();
    const res: any = await PATCH(makeRequest(REJECT_BODY));
    expect(res.status).toBe(200);
    expect(opsOn('users/member-1')).toHaveLength(0);
    const user = mockDocs['users/member-1'];
    expect(user).not.toHaveProperty('isOnVacation');
    expect(user).not.toHaveProperty('vacationMode');
    expect(user).not.toHaveProperty('coveringOfficerId');
    expect(user).not.toHaveProperty('leaveRequestId');
  });

  test('reject flips the leave request status to rejected and writes no leave_audit entry and no points_ledger entry', async () => {
    seedLeave();
    await PATCH(makeRequest(REJECT_BODY));
    expect(mockDocs['leave_requests/leave-1'].status).toBe('rejected');
    expect(auditSets()).toHaveLength(0);
    expect(ledgerSets()).toHaveLength(0);
  });

  test('revoke of an approved leave clears isOnVacation and vacationMode on the user doc', async () => {
    seedApprovedLeave();
    const res: any = await PATCH(makeRequest(REVOKE_BODY));
    expect(res.status).toBe(200);
    const user = mockDocs['users/member-1'];
    expect(user.isOnVacation).toBe(false);
    expect(user.vacationMode).toBe(false);
  });

  test('revoke of an approved leave clears leaveRequestId on the user doc', async () => {
    seedApprovedLeave();
    await PATCH(makeRequest(REVOKE_BODY));
    // Cleared means null or the field deleted entirely; both satisfy the
    // contract, since the implementation may use null or FieldValue.delete().
    expect(mockDocs['users/member-1'].leaveRequestId == null).toBe(true);
  });

  test('revoke marks the leave request completed', async () => {
    seedApprovedLeave();
    await PATCH(makeRequest(REVOKE_BODY));
    expect(mockDocs['leave_requests/leave-1'].status).toBe('completed');
  });

  test('revoke writes a leave_audit doc with action leave_revoked and awards no points', async () => {
    seedApprovedLeave();
    await PATCH(makeRequest(REVOKE_BODY));
    const audits = auditSets();
    expect(audits).toHaveLength(1);
    const audit = audits[0].data;
    expect(audit.action).toBe('leave_revoked');
    expect(audit.actorId).toBe('reviewer-1');
    expect(audit.targetUid).toBe('member-1');
    expect(audit.leaveRequestId).toBe('leave-1');
    expect(ledgerSets()).toHaveLength(0);
  });
});

describe('PATCH /api/admin/universal-review leave ref resolution (Worker D)', () => {
  beforeEach(() => {
    mockBatchOps.length = 0;
    mockDocs = {};
    autoIdCounter = 0;
    committedUpTo = 0;
    txChain = Promise.resolve();
  });

  test('global_id form reaches the leave branch: approve sets flags and audit', async () => {
    seedLeave();
    const res: any = await PATCH(makeRequest({ global_id: 'leave_requests/leave-1', action: 'approve' }));
    expect(res.status).toBe(200);
    const user = mockDocs['users/member-1'];
    expect(user.isOnVacation).toBe(true);
    expect(user.vacationMode).toBe(true);
    expect(user.coveringOfficerId).toBe('officer-1');
    expect(user.leaveRequestId).toBe('leave-1');
    expect(mockDocs['leave_requests/leave-1'].status).toBe('approved');
    expect(auditSets()).toHaveLength(1);
    expect(auditSets()[0].data.action).toBe('leave_approved');
  });

  test('original_ref form reaches the leave branch: reject flips status with no flags', async () => {
    seedLeave();
    const res: any = await PATCH(makeRequest({ original_ref: 'leave_requests/leave-1', action: 'reject' }));
    expect(res.status).toBe(200);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('rejected');
    expect(opsOn('users/member-1')).toHaveLength(0);
    expect(auditSets()).toHaveLength(0);
  });

  test('id form reaches the leave branch', async () => {
    seedLeave();
    const res: any = await PATCH(makeRequest({ id: 'leave_requests/leave-1', action: 'approve' }));
    expect(res.status).toBe(200);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].isOnVacation).toBe(true);
  });

  test('submissionId form reaches the leave branch', async () => {
    seedLeave();
    const res: any = await PATCH(
      makeRequest({ submissionId: 'leave_requests/leave-1', action: 'approve' }),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].isOnVacation).toBe(true);
  });

  test('collection plus leave_requests ref in ids reaches the leave branch', async () => {
    seedLeave();
    const res: any = await PATCH(
      makeRequest({ collection: 'leave_requests', ids: ['leave_requests/leave-1'], action: 'approve' }),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].isOnVacation).toBe(true);
    expect(auditSets()).toHaveLength(1);
  });

  test('homogeneous leave refs win over a wrong collection name and still award no points', async () => {
    seedLeave();
    const res: any = await PATCH(
      makeRequest({
        collection: 'submissions',
        ids: ['leave_requests/leave-1'],
        action: 'approve',
        points: 50,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('approved');
    expect(mockDocs['users/member-1'].isOnVacation).toBe(true);
    expect(ledgerSets()).toHaveLength(0);
    expect(mockDocs['users/member-1']).not.toHaveProperty('total_points');
  });

  test('second approve via global_id is reported in skippedAlreadyReviewed with no duplicate audit', async () => {
    seedLeave();
    const first: any = await PATCH(makeRequest({ global_id: 'leave_requests/leave-1', action: 'approve' }));
    expect(first.status).toBe(200);
    expect(auditSets()).toHaveLength(1);

    const second: any = await PATCH(makeRequest({ global_id: 'leave_requests/leave-1', action: 'approve' }));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.skippedAlreadyReviewed).toContain('leave-1');
    expect(auditSets()).toHaveLength(1);
    expect(mockDocs['users/member-1'].isOnVacation).toBe(true);
  });

  test('approve via ref with no resolvable requester reports failedLeaveRequests and changes no status', async () => {
    seedLeave();
    delete mockDocs['leave_requests/leave-1'].userId;
    const res: any = await PATCH(makeRequest({ global_id: 'leave_requests/leave-1', action: 'approve' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failedLeaveRequests).toEqual([
      expect.objectContaining({ id: 'leave-1' }),
    ]);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('pending');
    expect(auditSets()).toHaveLength(0);
    expect(opsOn('users/member-1')).toHaveLength(0);
  });

  test('revoke via global_id form revokes an approved leave', async () => {
    seedApprovedLeave();
    const res: any = await PATCH(makeRequest({ global_id: 'leave_requests/leave-1', action: 'revoke' }));
    expect(res.status).toBe(200);
    expect(mockDocs['leave_requests/leave-1'].status).toBe('completed');
  });

  test('non-leave submissions approve with points still writes a ledger entry (effectiveCollection regression)', async () => {
    mockDocs['submissions/sub-1'] = {
      userId: 'member-1',
      title: 'Entry',
      type: 'resource',
      status: 'pending',
    };
    mockDocs['users/reviewer-1'] = { displayName: 'Reviewer Admin' };
    mockDocs['users/member-1'] = { displayName: 'Member One' };
    const res: any = await PATCH(
      makeRequest({ collection: 'submissions', ids: ['sub-1'], action: 'approve', points: 10 }),
    );
    expect(res.status).toBe(200);
    expect(mockDocs['submissions/sub-1'].status).toBe('approved');
    expect(ledgerSets()).toHaveLength(1);
    expect(ledgerSets()[0].data.points_awarded).toBe(10);
  });
});
