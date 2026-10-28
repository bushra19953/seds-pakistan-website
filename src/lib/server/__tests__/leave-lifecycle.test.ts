/**
 * Tests for the leave lifecycle engine (src/lib/server/leave-lifecycle.ts).
 *
 * The engine runs against an in-memory Firestore fake whose batch
 * commits apply ops to the doc store, so a second run reads the
 * state the first run wrote (the idempotency argument is exercised,
 * not asserted from mocks). Completion goes through the REAL
 * returnFromLeave helper; the hr-leave seam is disabled and the
 * identity-primary flag is off, so every write lands in the fake.
 *
 * Fixed clock: NOW is 2026-10-28 10:00 UTC = 15:00 PKT, so Karachi
 * today is 2026-10-28 for every case below.
 */

let mockDocs: Record<string, any> = {};
let writeOps: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
let autoIdCounter = 0;

function isSentinel(value: any, kind: string): boolean {
  return value !== null && typeof value === 'object' && value.__fv === kind;
}

function applyValue(existing: any, value: any): any {
  if (isSentinel(value, 'serverTimestamp')) return 'SERVER_TIMESTAMP';
  if (isSentinel(value, 'delete')) return undefined;
  if (isSentinel(value, 'increment')) return (typeof existing === 'number' ? existing : 0) + value.n;
  if (isSentinel(value, 'arrayUnion')) {
    const base = Array.isArray(existing) ? existing : [];
    return [...base, ...value.vals.filter((v: any) => !base.includes(v))];
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

function matchesWhere(data: Record<string, any>, wheres: Array<[string, string, any]>): boolean {
  for (const [field, op, value] of wheres) {
    const actual = data?.[field];
    if (op === '==') {
      if (actual !== value) return false;
    } else if (op === 'array-contains') {
      if (!Array.isArray(actual) || !actual.includes(value)) return false;
    } else {
      throw new Error(`fake does not support op ${op}`);
    }
  }
  return true;
}

class FakeDocRef {
  constructor(
    public collectionPath: string,
    public id: string,
  ) {}
  get path(): string {
    return `${this.collectionPath}/${this.id}`;
  }
  async get(): Promise<any> {
    const data = mockDocs[this.path];
    return { exists: data !== undefined, id: this.id, ref: this, data: () => data };
  }
  collection(sub: string): FakeCollectionRef {
    return new FakeCollectionRef(`${this.path}/${sub}`);
  }
}

class FakeQuery {
  constructor(
    protected collectionPath: string,
    protected wheres: Array<[string, string, any]> = [],
    protected limitCount: number | null = null,
  ) {}
  where(field: string, op: string, value: any): FakeQuery {
    return new FakeQuery(this.collectionPath, [...this.wheres, [field, op, value]], this.limitCount);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.collectionPath, this.wheres, n);
  }
  async get(): Promise<any> {
    const prefix = `${this.collectionPath}/`;
    const docs: any[] = [];
    for (const [path, data] of Object.entries(mockDocs)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes('/')) continue;
      if (!matchesWhere(data, this.wheres)) continue;
      docs.push({
        id: rest,
        ref: new FakeDocRef(this.collectionPath, rest),
        data: () => data,
      });
    }
    const limited = this.limitCount !== null ? docs.slice(0, this.limitCount) : docs;
    return { docs: limited, empty: limited.length === 0, size: limited.length };
  }
}

class FakeCollectionRef extends FakeQuery {
  constructor(collectionPath: string) {
    super(collectionPath);
  }
  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.collectionPath, id ?? `gen-${++autoIdCounter}`);
  }
}

function makeBatch(): any {
  const ops: Array<{ op: string; path: string; data?: any; opts?: any }> = [];
  return {
    set: (ref: FakeDocRef, data: any, opts?: any) => {
      ops.push({ op: 'set', path: ref.path, data, opts });
    },
    update: (ref: FakeDocRef, data: any) => {
      ops.push({ op: 'update', path: ref.path, data });
    },
    delete: (ref: FakeDocRef) => {
      ops.push({ op: 'delete', path: ref.path });
    },
    commit: async () => {
      for (const op of ops) {
        if (op.op === 'set') {
          const base = op.opts?.merge ? (mockDocs[op.path] ?? {}) : {};
          mockDocs[op.path] = applyDataToDoc(base, op.data ?? {});
        } else if (op.op === 'update') {
          mockDocs[op.path] = applyDataToDoc(mockDocs[op.path] ?? {}, op.data ?? {});
        } else if (op.op === 'delete') {
          delete mockDocs[op.path];
        }
        writeOps.push(op);
      }
    },
  };
}

const mockDb: any = {
  collection: (name: string) => new FakeCollectionRef(name),
  batch: () => makeBatch(),
};

jest.mock('firebase-admin', () => {
  const FieldValue = {
    delete: () => ({ __fv: 'delete' }),
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
    increment: (n: number) => ({ __fv: 'increment', n }),
  };
  return { firestore: { FieldValue } };
});

jest.mock('@/lib/supa-seams/hr-leave', () => ({
  isLeaveSupaEnabled: () => false,
  tryListLeaveRequests: async () => ({ status: 'disabled' }),
  tryGetLeaveRequestRaw: async () => ({ status: 'disabled' }),
  mirrorLeaveRequestUpdate: async () => true,
  mirrorLeaveAuditSet: async () => true,
}));

jest.mock('@/lib/server/supa-identity-primary', () => ({
  identityPrimaryFlagOn: async () => false,
  primaryIdentitySet: jest.fn(async () => undefined),
  primaryIdentityUpdate: jest.fn(async () => undefined),
}));

import { runLeaveLifecycle, LEAVE_LIFECYCLE_ACTOR_ID } from '../leave-lifecycle';

const NOW = new Date('2026-10-28T10:00:00Z'); // Karachi today: 2026-10-28

function seedUser(uid: string, data: Record<string, any> = {}): void {
  mockDocs[`users/${uid}`] = { displayName: uid, ...data };
}

function seedApprovedLeave(id: string, data: Record<string, any>): void {
  mockDocs[`leave_requests/${id}`] = { status: 'approved', leaveType: 'annual', reason: 'test', ...data };
}

function auditDocs(action?: string): Array<{ path: string; data: any }> {
  return Object.entries(mockDocs)
    .filter(([path, data]) => path.startsWith('leave_audit/') && (!action || data?.action === action))
    .map(([path, data]) => ({ path, data }));
}

beforeEach(() => {
  mockDocs = {};
  writeOps = [];
  autoIdCounter = 0;
});

describe('runLeaveLifecycle: activation', () => {
  test('activates an approved leave on its start date with the approval flag payload', async () => {
    seedUser('member-1');
    seedApprovedLeave('leave-start-today', {
      userId: 'member-1',
      startDate: '2026-10-28',
      endDate: '2026-10-30',
      coveringOfficerId: 'officer-1',
    });

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.activated).toEqual([
      { leaveRequestId: 'leave-start-today', uid: 'member-1', applied: true },
    ]);
    const user = mockDocs['users/member-1'];
    expect(user.isOnVacation).toBe(true);
    expect(user.vacationMode).toBe(true);
    expect(user.coveringOfficerId).toBe('officer-1');
    expect(user.vacationStartDate).toBe('2026-10-28');
    expect(user.vacationEndDate).toBe('2026-10-30');
    expect(user.leaveRequestId).toBe('leave-start-today');
    const audits = auditDocs('leave_activated');
    expect(audits).toHaveLength(1);
    expect(audits[0].data.targetUid).toBe('member-1');
    expect(audits[0].data.actorId).toBe(LEAVE_LIFECYCLE_ACTOR_ID);
    expect(audits[0].data.leaveRequestId).toBe('leave-start-today');
    // The request itself stays approved; completion is a later phase.
    expect(mockDocs['leave_requests/leave-start-today'].status).toBe('approved');
  });

  test('does not activate a leave before its start date', async () => {
    seedUser('member-2');
    seedApprovedLeave('leave-future', {
      userId: 'member-2',
      startDate: '2026-11-05',
      endDate: '2026-11-07',
    });

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.activated).toEqual([]);
    expect(report.future).toBe(1);
    expect(mockDocs['users/member-2']).not.toHaveProperty('isOnVacation');
    expect(auditDocs()).toHaveLength(0);
    expect(writeOps).toHaveLength(0);
  });

  test('an already active leave is left untouched and reported as alreadyActive', async () => {
    seedUser('member-6', {
      isOnVacation: true,
      vacationMode: true,
      coveringOfficerId: null,
      vacationStartDate: '2026-10-27',
      vacationEndDate: '2026-10-29',
      leaveRequestId: 'leave-active',
    });
    seedApprovedLeave('leave-active', {
      userId: 'member-6',
      startDate: '2026-10-27',
      endDate: '2026-10-29',
    });
    const userBefore = { ...mockDocs['users/member-6'] };

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.alreadyActive).toBe(1);
    expect(report.activated).toEqual([]);
    expect(mockDocs['users/member-6']).toEqual(userBefore);
    expect(writeOps).toHaveLength(0);
  });
});

describe('runLeaveLifecycle: completion', () => {
  test('completes an active leave after its end date: flags cleared, request completed, audit written', async () => {
    seedUser('member-3', {
      isOnVacation: true,
      vacationMode: true,
      coveringOfficerId: 'officer-1',
      vacationStartDate: '2026-10-20',
      vacationEndDate: '2026-10-27',
      leaveRequestId: 'leave-ended',
    });
    seedApprovedLeave('leave-ended', {
      userId: 'member-3',
      startDate: '2026-10-20',
      endDate: '2026-10-27',
      coveringOfficerId: 'officer-1',
    });

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.completed).toEqual([
      { leaveRequestId: 'leave-ended', uid: 'member-3', applied: true },
    ]);
    const user = mockDocs['users/member-3'];
    expect(user.isOnVacation).toBe(false);
    expect(user.vacationMode).toBe(false);
    expect(user.leaveRequestId).toBeUndefined();
    const request = mockDocs['leave_requests/leave-ended'];
    expect(request.status).toBe('completed');
    expect(request.completedBy).toBe(LEAVE_LIFECYCLE_ACTOR_ID);
    const audits = auditDocs('leave_completed');
    expect(audits).toHaveLength(1);
    expect(audits[0].data.targetUid).toBe('member-3');
    expect(audits[0].data.actorId).toBe(LEAVE_LIFECYCLE_ACTOR_ID);
  });

  test('completes an ended leave that was never activated (flags never stamped)', async () => {
    seedUser('member-4');
    seedApprovedLeave('leave-ended-unactivated', {
      userId: 'member-4',
      startDate: '2026-10-21',
      endDate: '2026-10-26',
    });

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.completed).toEqual([
      { leaveRequestId: 'leave-ended-unactivated', uid: 'member-4', applied: true },
    ]);
    expect(mockDocs['leave_requests/leave-ended-unactivated'].status).toBe('completed');
    expect(mockDocs['users/member-4'].isOnVacation).toBe(false);
    expect(mockDocs['users/member-4'].vacationMode).toBe(false);
  });

  test('an ended leave completes status-only when the member flags belong to a different active leave', async () => {
    seedUser('member-7', {
      isOnVacation: true,
      vacationMode: true,
      vacationStartDate: '2026-10-27',
      vacationEndDate: '2026-10-29',
      leaveRequestId: 'leave-current',
    });
    seedApprovedLeave('leave-old-ended', {
      userId: 'member-7',
      startDate: '2026-10-20',
      endDate: '2026-10-25',
    });
    seedApprovedLeave('leave-current', {
      userId: 'member-7',
      startDate: '2026-10-27',
      endDate: '2026-10-29',
    });

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.completed).toEqual([
      { leaveRequestId: 'leave-old-ended', uid: 'member-7', applied: true },
    ]);
    expect(mockDocs['leave_requests/leave-old-ended'].status).toBe('completed');
    // The other leave's flags are exactly as they were.
    const user = mockDocs['users/member-7'];
    expect(user.isOnVacation).toBe(true);
    expect(user.vacationMode).toBe(true);
    expect(user.leaveRequestId).toBe('leave-current');
    expect(mockDocs['leave_requests/leave-current'].status).toBe('approved');
    expect(report.alreadyActive).toBe(1);
  });
});

describe('runLeaveLifecycle: premature flags (old approval drift)', () => {
  test('clears flags stamped early for a future leave and keeps the request approved', async () => {
    seedUser('member-5', {
      isOnVacation: true,
      vacationMode: true,
      coveringOfficerId: null,
      vacationStartDate: '2026-11-02',
      vacationEndDate: '2026-11-04',
      leaveRequestId: 'leave-premature',
    });
    seedApprovedLeave('leave-premature', {
      userId: 'member-5',
      startDate: '2026-11-02',
      endDate: '2026-11-04',
    });

    const report = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });

    expect(report.deactivated).toEqual([
      { leaveRequestId: 'leave-premature', uid: 'member-5', applied: true },
    ]);
    const user = mockDocs['users/member-5'];
    expect(user.isOnVacation).toBe(false);
    expect(user.vacationMode).toBe(false);
    expect(user.leaveRequestId).toBeUndefined();
    expect(mockDocs['leave_requests/leave-premature'].status).toBe('approved');
    expect(auditDocs('leave_deactivated')).toHaveLength(1);
  });
});

describe('runLeaveLifecycle: dry-run and idempotency', () => {
  function seedMixed(): void {
    seedUser('member-1');
    seedApprovedLeave('leave-start-today', {
      userId: 'member-1',
      startDate: '2026-10-28',
      endDate: '2026-10-30',
      coveringOfficerId: 'officer-1',
    });
    seedUser('member-3', {
      isOnVacation: true,
      vacationMode: true,
      vacationStartDate: '2026-10-20',
      vacationEndDate: '2026-10-27',
      leaveRequestId: 'leave-ended',
    });
    seedApprovedLeave('leave-ended', {
      userId: 'member-3',
      startDate: '2026-10-20',
      endDate: '2026-10-27',
    });
    seedUser('member-5', {
      isOnVacation: true,
      vacationMode: true,
      vacationStartDate: '2026-11-02',
      vacationEndDate: '2026-11-04',
      leaveRequestId: 'leave-premature',
    });
    seedApprovedLeave('leave-premature', {
      userId: 'member-5',
      startDate: '2026-11-02',
      endDate: '2026-11-04',
    });
  }

  test('dry-run classifies every action and writes nothing', async () => {
    seedMixed();
    const before = JSON.parse(JSON.stringify(mockDocs));

    const report = await runLeaveLifecycle(mockDb, { mode: 'dry-run', now: NOW });

    expect(report.mode).toBe('dry-run');
    expect(report.activated).toEqual([
      { leaveRequestId: 'leave-start-today', uid: 'member-1', applied: false },
    ]);
    expect(report.completed).toEqual([
      { leaveRequestId: 'leave-ended', uid: 'member-3', applied: false },
    ]);
    expect(report.deactivated).toEqual([
      { leaveRequestId: 'leave-premature', uid: 'member-5', applied: false },
    ]);
    expect(writeOps).toHaveLength(0);
    expect(mockDocs).toEqual(before);
  });

  test('a second repair run over the settled state writes nothing', async () => {
    seedMixed();

    const first = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });
    expect(first.activated).toHaveLength(1);
    expect(first.completed).toHaveLength(1);
    expect(first.deactivated).toHaveLength(1);
    const writesAfterFirst = writeOps.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    const second = await runLeaveLifecycle(mockDb, { mode: 'repair', now: NOW });
    expect(second.activated).toEqual([]);
    expect(second.completed).toEqual([]);
    expect(second.deactivated).toEqual([]);
    // The start-today leave is now simply active; nothing else qualifies.
    expect(second.alreadyActive).toBe(1);
    expect(writeOps).toHaveLength(writesAfterFirst);
    expect(auditDocs()).toHaveLength(3);
  });
});
