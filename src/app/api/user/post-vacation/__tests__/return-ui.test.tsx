/**
 * Slice 18: Tests for the return-from-leave flow, the leave card, and the
 * post-vacation summary modal.
 *
 * Placement: copy this file to
 *   src/app/api/user/post-vacation/__tests__/return-ui.test.tsx
 * (note the .tsx extension: this file renders components, so it needs JSX).
 * The @/ alias keeps every import working from any __tests__ directory.
 *
 * What this file tests (33 tests):
 * - returnFromLeave in src/lib/server/leave-return.ts (Slice 06 contract):
 *   the shared helper that owns ALL return-from-leave state changes.
 * - POST /api/user/post-vacation in src/app/api/user/post-vacation/route.ts
 *   (Slice 07 contract): the member self-return route that authenticates,
 *   gates on the on-leave flags, and delegates to the helper.
 * - VacationToggle in src/components/profile/vacation-toggle.tsx (Slice 12
 *   contract): the profile leave card, with its Firebase hooks mocked.
 * - PostVacationSummaryModal in
 *   src/components/dashboard/post-vacation-summary.tsx (Slice 13 contract):
 *   the presentational modal, rendered for real.
 *
 * Contract notes the tests pin down:
 * - The helper does NOT throw a "not on leave" error. When there is
 *   nothing to do (flags clear, no approved request, no redirected or
 *   held tasks) it returns alreadyReturned: true and writes nothing.
 *   The "return when NOT on leave" error is enforced by the ROUTE gate,
 *   which returns 400 with "You are not currently on leave. Nothing was
 *   changed." and changes nothing. Both layers are tested below.
 * - A second return at the ROUTE level hits the route gate (flags are
 *   already clear) and returns 400 with nothing changed. A second return
 *   at the HELPER level returns alreadyReturned: true and writes
 *   nothing, including no second audit entry. Both are idempotent in
 *   effect; only the response shape differs.
 * - The helper restores tasks by reading ALL tasks with
 *   redirectedFrom == uid and filtering statuses in code, so both
 *   spellings of in-progress ('in_progress' and 'in-progress') restore.
 * - coveringOfficerId and the vacation dates are KEPT on return (history).
 *   Only the two flags are cleared and leaveRequestId is deleted.
 * - The helper writes exactly one leave_audit entry per effective return,
 *   one activity entry per restored task, and one activity entry per
 *   held task that was cleared.
 *
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NextRequest } from 'next/server';

import { returnFromLeave, RESTORABLE_TASK_STATUSES } from '@/lib/server/leave-return';
import { POST } from '@/app/api/user/post-vacation/route';
import VacationToggle from '@/components/profile/vacation-toggle';
import { PostVacationSummaryModal } from '@/components/dashboard/post-vacation-summary';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const mockState = {
  store: {} as Record<string, any>,
  writes: [] as Array<{ op: string; path: string; data?: any }>,
  genCounter: 0,
};

const mockAuth = {
  current: {
    authenticated: true,
    user: { userId: 'member-uid', displayName: 'Test Member', email: 'member@example.com' },
  } as any,
};

const mockUserContext = {
  current: {
    user: { uid: 'member-uid', getIdToken: async () => 'test-token' },
    isLoading: false,
  } as any,
};

const mockDocState = {
  current: { data: null as any, loading: false, error: null as any },
};

const mockOfficerSnap = {
  current: { exists: () => true, data: () => ({ displayName: 'Cover Officer' }) } as any,
};

const mockFirestore = {} as any;

const mockFetchState = {
  postOk: true,
  postBody: { success: true, restoredCount: 2, heldClearedCount: 1 } as any,
};

const mockFetchCalls: Array<{ url: string; init: any }> = [];

function isDeleteSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as any).__fv === 'delete';
}

function isTimestampSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as any).__fv === 'serverTimestamp';
}

function convertValue(value: any): any {
  if (isTimestampSentinel(value)) return 'SERVER_TIMESTAMP';
  if (isDeleteSentinel(value)) return undefined;
  if (Array.isArray(value)) return value.map(convertValue);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isDeleteSentinel(v)) continue;
      out[k] = convertValue(v);
    }
    return out;
  }
  return value;
}

function applyUpdate(path: string, data: any): void {
  const existing = mockState.store[path];
  if (existing === undefined) throw new Error(`Document does not exist: ${path}`);
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) {
    if (isDeleteSentinel(v)) delete next[k];
    else next[k] = convertValue(v);
  }
  mockState.store[path] = next;
}

function applySet(data: any): any {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (isDeleteSentinel(v)) continue;
    out[k] = convertValue(v);
  }
  return out;
}

function makeDocRef(path: string): any {
  const id = path.split('/').pop() as string;
  return {
    id,
    path,
    get: async () => {
      const data = mockState.store[path];
      return { exists: data !== undefined, data: () => data, ref: makeDocRef(path) };
    },
    collection: (subName: string) => makeCollection(`${path}/${subName}`),
  };
}

function makeQuery(collectionName: string, filters: Array<{ field: string; op: string; val: any }>): any {
  return {
    where: (field: string, op: string, val: any) =>
      makeQuery(collectionName, [...filters, { field, op, val }]),
    get: async () => {
      const docs = Object.entries(mockState.store)
        .filter(
          ([p]) =>
            p.startsWith(`${collectionName}/`) &&
            p.slice(collectionName.length + 1).split('/').length === 1,
        )
        .filter(([, data]) =>
          filters.every((f) => (f.op === '==' ? (data as any)[f.field] === f.val : false)),
        )
        .map(([p, data]) => ({
          id: p.split('/').pop() as string,
          ref: makeDocRef(p),
          data: () => data,
        }));
      return { docs };
    },
  };
}

function makeCollection(name: string): any {
  return {
    doc: (id?: string) => makeDocRef(`${name}/${id ?? `gen-${++mockState.genCounter}`}`),
    where: (field: string, op: string, val: any) => makeQuery(name, [{ field, op, val }]),
  };
}

const mockDb = {
  collection: (name: string) => makeCollection(name),
  batch: () => {
    const ops: Array<{ op: string; ref: any; data?: any }> = [];
    return {
      update: (ref: any, data: any) => {
        ops.push({ op: 'update', ref, data });
      },
      set: (ref: any, data: any) => {
        ops.push({ op: 'set', ref, data });
      },
      delete: (ref: any) => {
        ops.push({ op: 'delete', ref });
      },
      commit: async () => {
        for (const op of ops) {
          mockState.writes.push({ op: op.op, path: op.ref.path, data: op.data });
          if (op.op === 'update') applyUpdate(op.ref.path, op.data);
          else if (op.op === 'set') mockState.store[op.ref.path] = applySet(op.data);
          else if (op.op === 'delete') delete mockState.store[op.ref.path];
        }
      },
    };
  },
};

jest.mock('firebase-admin', () => ({
  firestore: {
    FieldValue: {
      delete: () => ({ __fv: 'delete' }),
      serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    },
  },
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDb,
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => mockAuth.current),
}));

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

jest.mock('@/firebase/user-provider', () => ({
  useUserContext: () => mockUserContext.current,
}));

jest.mock('@/firebase', () => ({
  useDoc: () => mockDocState.current,
  useFirestore: () => mockFirestore,
}));

jest.mock('firebase/firestore', () => ({
  doc: (...args: any[]) => ({ path: args.join('/') }),
  getDoc: async () => mockOfficerSnap.current,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <h2>{children}</h2>,
  CardDescription: ({ children }: any) => <p>{children}</p>,
  CardContent: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));

jest.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => <div />,
}));

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

function seedOnLeave(): void {
  mockState.store = {
    'users/member-uid': {
      displayName: 'Test Member',
      email: 'member@example.com',
      isOnVacation: true,
      vacationMode: true,
      coveringOfficerId: 'officer-uid',
      vacationStartDate: '2026-10-10T12:00:00',
      vacationEndDate: '2026-10-14T12:00:00',
      leaveRequestId: 'leave-1',
    },
    'leave_requests/leave-1': {
      userId: 'member-uid',
      status: 'approved',
      startDate: '2026-10-10',
      endDate: '2026-10-14',
      coveringOfficerId: 'officer-uid',
      reason: 'Annual leave',
    },
    'tasks/task-redirected-pending': {
      title: 'Pending task',
      status: 'pending',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
      redirectedBy: 'system-leave',
      redirectedLeaveRequestId: 'leave-1',
    },
    'tasks/task-redirected-progress': {
      title: 'Progress task',
      status: 'in_progress',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
      redirectedBy: 'system-leave',
      redirectedLeaveRequestId: 'leave-1',
    },
    'tasks/task-redirected-hyphen': {
      title: 'Hyphen progress task',
      status: 'in-progress',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
      redirectedBy: 'system-leave',
      redirectedLeaveRequestId: 'leave-1',
    },
    'tasks/task-redirected-locked': {
      title: 'Locked task',
      status: 'locked',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
      redirectedBy: 'system-leave',
      redirectedLeaveRequestId: 'leave-1',
    },
    'tasks/task-held': {
      title: 'Held task',
      status: 'pending',
      assigneeId: 'member-uid',
      leaveHold: true,
      leaveHoldReason: 'no-covering-officer',
    },
    'tasks/task-completed': {
      title: 'Done task',
      status: 'completed',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
    },
    'tasks/task-other': {
      title: 'Other task',
      status: 'pending',
      assigneeId: 'someone-else',
    },
  };
  mockState.writes = [];
  mockState.genCounter = 0;
}

function seedNotOnLeave(): void {
  mockState.store = {
    'users/member-uid': {
      displayName: 'Test Member',
      email: 'member@example.com',
      isOnVacation: false,
      vacationMode: false,
      coveringOfficerId: null,
    },
    'tasks/task-other': {
      title: 'Other task',
      status: 'pending',
      assigneeId: 'someone-else',
    },
  };
  mockState.writes = [];
  mockState.genCounter = 0;
}

function seedOrphanedWork(): void {
  mockState.store = {
    'users/member-uid': {
      displayName: 'Test Member',
      email: 'member@example.com',
      isOnVacation: false,
      vacationMode: false,
      coveringOfficerId: 'officer-uid',
      leaveRequestId: 'leave-1',
    },
    'leave_requests/leave-1': {
      userId: 'member-uid',
      status: 'approved',
      startDate: '2026-10-10',
      endDate: '2026-10-14',
      coveringOfficerId: 'officer-uid',
      reason: 'Annual leave',
    },
    'tasks/task-redirected-pending': {
      title: 'Orphaned redirected task',
      status: 'pending',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
    },
  };
  mockState.writes = [];
  mockState.genCounter = 0;
}

function seedDanglingRequest(): void {
  mockState.store = {
    'users/member-uid': {
      displayName: 'Test Member',
      email: 'member@example.com',
      isOnVacation: true,
      vacationMode: true,
      coveringOfficerId: 'officer-uid',
      leaveRequestId: 'leave-missing',
    },
    'tasks/task-redirected-pending': {
      title: 'Redirected task',
      status: 'pending',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
    },
  };
  mockState.writes = [];
  mockState.genCounter = 0;
}

function seedManyRedirected(count: number): void {
  const store: Record<string, any> = {
    'users/member-uid': {
      displayName: 'Test Member',
      email: 'member@example.com',
      isOnVacation: true,
      vacationMode: true,
      coveringOfficerId: 'officer-uid',
      leaveRequestId: 'leave-1',
    },
    'leave_requests/leave-1': {
      userId: 'member-uid',
      status: 'approved',
      startDate: '2026-10-10',
      endDate: '2026-10-14',
      coveringOfficerId: 'officer-uid',
      reason: 'Annual leave',
    },
  };
  for (let i = 0; i < count; i += 1) {
    store[`tasks/task-redirected-${i}`] = {
      title: `Redirected task ${i}`,
      status: 'pending',
      assigneeId: 'officer-uid',
      redirectedFrom: 'member-uid',
    };
  }
  mockState.store = store;
  mockState.writes = [];
  mockState.genCounter = 0;
}

function auditEntries(): Array<[string, any]> {
  return Object.entries(mockState.store).filter(([p]) => p.startsWith('leave_audit/'));
}

function activityEntries(): Array<[string, any]> {
  return Object.entries(mockState.store).filter(([p]) => p.includes('/activity/'));
}

function postRequest(body: any = {}): any {
  return { json: async () => body } as unknown as NextRequest;
}

function onLeaveUserDoc(): any {
  return {
    isOnVacation: true,
    vacationMode: true,
    coveringOfficerId: 'officer-uid',
    leaveRequestId: 'leave-1',
    vacationStartDate: '2026-10-10T12:00:00',
    vacationEndDate: '2026-10-14T12:00:00',
  };
}

beforeEach(() => {
  seedOnLeave();
  mockAuth.current = {
    authenticated: true,
    user: { userId: 'member-uid', displayName: 'Test Member', email: 'member@example.com' },
  };
  mockUserContext.current = {
    user: { uid: 'member-uid', getIdToken: async () => 'test-token' },
    isLoading: false,
  };
  mockDocState.current = { data: onLeaveUserDoc(), loading: false, error: null };
  mockOfficerSnap.current = { exists: () => true, data: () => ({ displayName: 'Cover Officer' }) };
  mockFetchState.postOk = true;
  mockFetchState.postBody = { success: true, restoredCount: 2, heldClearedCount: 1 };
  mockFetchCalls.length = 0;
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const urlText = String(url);
    if (urlText.includes('/api/user/post-vacation')) {
      mockFetchCalls.push({ url: urlText, init });
      if (!mockFetchState.postOk) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'You are not currently on leave. Nothing was changed.' }),
        };
      }
      return { ok: true, status: 200, json: async () => mockFetchState.postBody };
    }
    return { ok: true, status: 200, json: async () => [] };
  }) as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// returnFromLeave helper (Slice 06)
// ---------------------------------------------------------------------------

describe('returnFromLeave helper', () => {
  test('restores redirected tasks to the original assignee and clears redirectedFrom', async () => {
    expect(RESTORABLE_TASK_STATUSES).toContain('pending');
    expect(RESTORABLE_TASK_STATUSES).toContain('in_progress');
    expect(RESTORABLE_TASK_STATUSES).toContain('in-progress');
    expect(RESTORABLE_TASK_STATUSES).toContain('locked');

    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });

    expect(result.restoredCount).toBe(4);
    expect(result.heldClearedCount).toBe(1);
    expect(result.alreadyReturned).toBe(false);
    expect(result.leaveRequestId).toBe('leave-1');
    expect(result.requestCompleted).toBe(true);
    expect(result.targetUid).toBe('member-uid');

    for (const taskId of [
      'task-redirected-pending',
      'task-redirected-progress',
      'task-redirected-hyphen',
      'task-redirected-locked',
    ]) {
      const task = mockState.store[`tasks/${taskId}`];
      expect(task.assigneeId).toBe('member-uid');
      expect(task).not.toHaveProperty('redirectedFrom');
    }
  });

  test('leaves non-restorable tasks untouched even when they carry redirectedFrom', async () => {
    const before = JSON.parse(JSON.stringify(mockState.store['tasks/task-completed']));
    await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    expect(mockState.store['tasks/task-completed']).toEqual(before);
    expect(mockState.store['tasks/task-other']).toEqual({
      title: 'Other task',
      status: 'pending',
      assigneeId: 'someone-else',
    });
  });

  test('clears leaveHold on held tasks and leaves the assignee unchanged', async () => {
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    expect(result.heldClearedCount).toBe(1);
    const held = mockState.store['tasks/task-held'];
    expect(held.assigneeId).toBe('member-uid');
    expect(held.leaveHold).toBe(false);
    expect(held).not.toHaveProperty('leaveHoldReason');
  });

  test('clears both vacation flags, keeps covering officer and dates, deletes leaveRequestId', async () => {
    await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    const user = mockState.store['users/member-uid'];
    expect(user.isOnVacation).toBe(false);
    expect(user.vacationMode).toBe(false);
    expect(user.coveringOfficerId).toBe('officer-uid');
    expect(user.vacationStartDate).toBe('2026-10-10T12:00:00');
    expect(user.vacationEndDate).toBe('2026-10-14T12:00:00');
    expect(user).not.toHaveProperty('leaveRequestId');
  });

  test('marks the approved leave request completed with return fields', async () => {
    await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    const request = mockState.store['leave_requests/leave-1'];
    expect(request.status).toBe('completed');
    expect(request.returnedBy).toBe('member-uid');
    expect(request.returnedAt).toBe('SERVER_TIMESTAMP');
    expect(request.returnReason).toBeNull();
  });

  test('leaves a pending request untouched and reports requestCompleted false', async () => {
    mockState.store['leave_requests/leave-1'].status = 'pending';
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    expect(result.requestCompleted).toBe(false);
    expect(mockState.store['leave_requests/leave-1'].status).toBe('pending');
    expect(mockState.store['users/member-uid'].isOnVacation).toBe(false);
  });

  test('writes exactly one leave_audit entry with action leave_returned and both counts', async () => {
    await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    const audits = auditEntries();
    expect(audits).toHaveLength(1);
    const audit = audits[0][1];
    expect(audit.action).toBe('leave_returned');
    expect(audit.actorId).toBe('member-uid');
    expect(audit.targetUid).toBe('member-uid');
    expect(audit.leaveRequestId).toBe('leave-1');
    expect(audit.restoredCount).toBe(4);
    expect(audit.heldClearedCount).toBe(1);
  });

  test('writes one activity entry per restored task and per cleared held task', async () => {
    await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    const activities = activityEntries();
    expect(activities).toHaveLength(5);
    const reassigns = activities.filter(([, data]) => data.type === 'reassign');
    expect(reassigns).toHaveLength(4);
    for (const [, data] of reassigns) {
      expect(data.data.newAssigneeId).toBe('member-uid');
      expect(data.data.previousAssigneeId).toBe('officer-uid');
      expect(data.data.reason).toBe('Return from leave, workload restored');
    }
    const holdClears = activities.filter(([, data]) => data.type === 'leave_hold_cleared');
    expect(holdClears).toHaveLength(1);
    expect(holdClears[0][1].data.reason).toBe('Return from leave, hold cleared');
  });

  test('second call is a no-op that writes nothing, including no second audit', async () => {
    await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    const writesAfterFirst = mockState.writes.length;
    expect(auditEntries()).toHaveLength(1);

    const second = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    expect(second.alreadyReturned).toBe(true);
    expect(second.restoredCount).toBe(0);
    expect(second.heldClearedCount).toBe(0);
    expect(mockState.writes.length).toBe(writesAfterFirst);
    expect(auditEntries()).toHaveLength(1);
  });

  test('returns alreadyReturned and writes nothing when not on leave and nothing is owed', async () => {
    seedNotOnLeave();
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      actorId: 'member-uid',
    });
    expect(result.alreadyReturned).toBe(true);
    expect(result.restoredCount).toBe(0);
    expect(result.heldClearedCount).toBe(0);
    expect(mockState.writes).toHaveLength(0);
  });

  test('restores orphaned redirected tasks even when the flags are already clear', async () => {
    seedOrphanedWork();
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      actorId: 'member-uid',
    });
    expect(result.alreadyReturned).toBe(false);
    expect(result.restoredCount).toBe(1);
    expect(result.requestCompleted).toBe(true);
    expect(mockState.store['tasks/task-redirected-pending'].assigneeId).toBe('member-uid');
    expect(mockState.store['leave_requests/leave-1'].status).toBe('completed');
  });

  test('throws when the explicit leaveRequestId does not match the user doc', async () => {
    const before = JSON.stringify(mockState.store);
    await expect(
      returnFromLeave(mockDb as any, {
        uid: 'member-uid',
        leaveRequestId: 'leave-2',
        actorId: 'member-uid',
      }),
    ).rejects.toThrow(/different leave request/i);
    expect(JSON.stringify(mockState.store)).toBe(before);
    expect(mockState.writes).toHaveLength(0);
  });

  test('throws when the user record does not exist', async () => {
    await expect(
      returnFromLeave(mockDb as any, { uid: 'ghost-uid', actorId: 'ghost-uid' }),
    ).rejects.toThrow(/user record not found/i);
  });

  test('still clears flags and restores work when the request doc is a dangling pointer', async () => {
    seedDanglingRequest();
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      actorId: 'member-uid',
    });
    expect(result.requestCompleted).toBe(false);
    expect(result.leaveRequestId).toBe('leave-missing');
    expect(result.restoredCount).toBe(1);
    expect(mockState.store['users/member-uid'].isOnVacation).toBe(false);
    expect(mockState.store['tasks/task-redirected-pending'].assigneeId).toBe('member-uid');
  });

  test('revoke path writes leave_revoked audit and revocation fields on the request', async () => {
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'admin-uid',
      auditAction: 'leave_revoked',
      reason: 'Admin revoked',
    });
    expect(result.restoredCount).toBe(4);
    const audits = auditEntries();
    expect(audits).toHaveLength(1);
    expect(audits[0][1].action).toBe('leave_revoked');
    expect(audits[0][1].reason).toBe('Admin revoked');
    const request = mockState.store['leave_requests/leave-1'];
    expect(request.status).toBe('completed');
    expect(request.revokedBy).toBe('admin-uid');
    expect(request.revocationReason).toBe('Admin revoked');
    expect(request.revokedAt).toBe('SERVER_TIMESTAMP');
  });

  test('chunks more than 150 tasks and still writes exactly one audit entry', async () => {
    seedManyRedirected(160);
    const result = await returnFromLeave(mockDb as any, {
      uid: 'member-uid',
      leaveRequestId: 'leave-1',
      actorId: 'member-uid',
    });
    expect(result.restoredCount).toBe(160);
    expect(auditEntries()).toHaveLength(1);
    for (let i = 0; i < 160; i += 1) {
      const task = mockState.store[`tasks/task-redirected-${i}`];
      expect(task.assigneeId).toBe('member-uid');
      expect(task).not.toHaveProperty('redirectedFrom');
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/user/post-vacation (Slice 07)
// ---------------------------------------------------------------------------

describe('POST /api/user/post-vacation', () => {
  test('rejects unauthenticated callers with 401 and writes nothing', async () => {
    mockAuth.current = { authenticated: false };
    const res: any = await POST(postRequest({}));
    expect(res.status).toBe(401);
    expect(mockState.writes).toHaveLength(0);
  });

  test('returns a clear error and changes nothing when the caller is not on leave', async () => {
    seedNotOnLeave();
    const before = JSON.stringify(mockState.store);
    const res: any = await POST(postRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not currently on leave/i);
    expect(body.error).toMatch(/nothing was changed/i);
    expect(JSON.stringify(mockState.store)).toBe(before);
    expect(mockState.writes).toHaveLength(0);
  });

  test('returns restored counts for an on-leave member and clears the flags', async () => {
    const res: any = await POST(postRequest({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.restoredCount).toBe(4);
    expect(body.alreadyReturned).toBe(false);
    expect(body.leaveRequestId).toBe('leave-1');
    expect(mockState.store['users/member-uid'].isOnVacation).toBe(false);
    expect(mockState.store['leave_requests/leave-1'].status).toBe('completed');
  });

  test('returns a clear error and changes nothing when the request was never approved', async () => {
    mockState.store['leave_requests/leave-1'].status = 'pending';
    const before = JSON.stringify(mockState.store);
    const res: any = await POST(postRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not approved/i);
    expect(JSON.stringify(mockState.store)).toBe(before);
    expect(mockState.writes).toHaveLength(0);
  });

  test('returns 403 and changes nothing when the request belongs to another user', async () => {
    mockState.store['leave_requests/leave-1'].userId = 'other-uid';
    const before = JSON.stringify(mockState.store);
    const res: any = await POST(postRequest({ leaveRequestId: 'leave-1' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/belongs to another user/i);
    expect(JSON.stringify(mockState.store)).toBe(before);
    expect(mockState.writes).toHaveLength(0);
  });

  test('second POST changes nothing: the route gate rejects it because the flags are clear', async () => {
    const first: any = await POST(postRequest({}));
    expect(first.status).toBe(200);
    const writesAfterFirst = mockState.writes.length;
    expect(auditEntries()).toHaveLength(1);

    const second: any = await POST(postRequest({}));
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.error).toMatch(/not currently on leave/i);
    expect(mockState.writes.length).toBe(writesAfterFirst);
    expect(auditEntries()).toHaveLength(1);
  });

  test('rejects a non-string leaveRequestId in the body with 400', async () => {
    const res: any = await POST(postRequest({ leaveRequestId: 123 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/leaveRequestId must be a non-empty string/i);
    expect(mockState.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Leave card (Slice 12)
// ---------------------------------------------------------------------------

describe('leave card', () => {
  test('shows On Leave state with dates and covering officer when flagged', async () => {
    render(<VacationToggle />);
    expect(screen.getByText('On Leave')).toBeInTheDocument();
    expect(screen.getByText(/On leave from 10 Oct 2026 to 14 Oct 2026\./)).toBeInTheDocument();
    await waitFor(() => {
      expect(document.body.textContent).toContain('5 days');
      expect(document.body.textContent).toContain('Covering officer: Cover Officer');
    });
    expect(screen.getByRole('button', { name: /Return from Leave/i })).toBeInTheDocument();
  });

  test('shows Apply state and hides Return when not on leave', async () => {
    mockDocState.current = {
      data: { isOnVacation: false, vacationMode: false, coveringOfficerId: null },
      loading: false,
      error: null,
    };
    render(<VacationToggle />);
    expect(screen.getByText('Not On Leave')).toBeInTheDocument();
    // "Apply for Leave" appears twice: the section heading and the link.
    expect(screen.getAllByText('Apply for Leave')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Apply for Leave' })).toHaveAttribute(
      'href',
      '/profile/leave',
    );
    expect(screen.queryByRole('button', { name: /Return from Leave/i })).toBeNull();
    expect(await screen.findByText(/You have no leave requests yet\./)).toBeInTheDocument();
  });

  test('Return button posts to post-vacation with the leave request id and shows counts', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VacationToggle />);
    fireEvent.click(screen.getByRole('button', { name: /Return from Leave/i }));

    await screen.findByText(/Welcome back\. Your return from leave is complete\./);
    expect(screen.getByText(/2 redirected tasks restored to you\./)).toBeInTheDocument();
    expect(screen.getByText(/1 held task released\./)).toBeInTheDocument();

    const postCall = mockFetchCalls.find((call) => call.url.includes('/api/user/post-vacation'));
    expect(postCall).toBeDefined();
    expect(postCall!.init.method).toBe('POST');
    expect(JSON.parse(postCall!.init.body)).toEqual({ leaveRequestId: 'leave-1' });
  });

  test('Return failure shows the server error and changes no card state', async () => {
    mockFetchState.postOk = false;
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VacationToggle />);
    fireEvent.click(screen.getByRole('button', { name: /Return from Leave/i }));

    await screen.findByText(/You are not currently on leave\. Nothing was changed\./);
    expect(screen.getByText('On Leave')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Post-vacation summary modal (Slice 13)
// ---------------------------------------------------------------------------

describe('post-vacation summary modal', () => {
  test('renders counts after return', () => {
    render(
      <PostVacationSummaryModal
        open
        restoredCount={2}
        heldClearedCount={1}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByText(/Your work is back\./)).toBeInTheDocument();
    // The count lines split the number and the words across elements, so
    // assert on the dialog text content instead of a single text node.
    const dialogText = screen.getByRole('dialog').textContent || '';
    expect(dialogText).toContain('2 tasks restored to you.');
    expect(dialogText).toContain('1 held task cleared.');
  });

  test('uses singular wording for one task and plural for zero', () => {
    render(
      <PostVacationSummaryModal
        open
        restoredCount={1}
        heldClearedCount={0}
        onClose={() => {}}
      />,
    );
    const dialogText = screen.getByRole('dialog').textContent || '';
    expect(dialogText).toContain('1 task restored to you.');
    expect(dialogText).toContain('0 held tasks cleared.');
  });

  test('renders nothing when closed', () => {
    const { container } = render(
      <PostVacationSummaryModal
        open={false}
        restoredCount={2}
        heldClearedCount={1}
        onClose={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Close button calls onClose', () => {
    const onClose = jest.fn();
    render(
      <PostVacationSummaryModal open restoredCount={2} heldClearedCount={1} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Escape key calls onClose', () => {
    const onClose = jest.fn();
    render(
      <PostVacationSummaryModal open restoredCount={2} heldClearedCount={1} onClose={onClose} />,
    );
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('backdrop click calls onClose', () => {
    const onClose = jest.fn();
    render(
      <PostVacationSummaryModal open restoredCount={2} heldClearedCount={1} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId('post-vacation-summary-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
