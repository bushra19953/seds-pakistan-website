/**
 * @jest-environment node
 *
 * Handler-level tests for the leave route (src/app/api/leave/route.ts).
 *
 * These tests specify the Step 1 contract from the leave adaptation guide:
 * a member files a leave request, the server forces ownership and status,
 * validates dates / leave type / covering officer, rejects overlapping
 * pending or approved leaves, lists only the caller's own requests, and
 * lets the caller cancel their own pending request.
 *
 * Mocking pattern copied from the repo's existing API route tests
 * (src/app/api/client-errors/__tests__/route.test.ts and
 * src/app/api/tasks/__tests__/route.step-resources.test.ts):
 * the auth helper and the Admin SDK Firestore handle are mocked, and
 * Firestore is an in-memory fake that supports chained where / orderBy /
 * get, add, and doc get / set / update, so the real handler code runs.
 *
 * Contract decisions pinned by these tests (see NOTES.md in the slice
 * folder for the full list):
 * - POST success returns 201 with { id, status: 'pending' }.
 * - Validation failures return 400 with { error }. Overlapping leave and
 *   cancelling a non-pending leave return 409. Cancelling someone else's
 *   leave returns 403. Unknown leave id returns 404. Unauthenticated
 *   requests return 401.
 * - Client-supplied userId and status are ignored: the stored doc always
 *   carries the caller's uid and status 'pending'.
 * - Cancel is PATCH with body { action: 'cancel', id }.
 * - Leave length is inclusive: (endDate - startDate) in days + 1. A leave
 *   longer than 3 days requires a covering officer.
 * - GET returns the caller's own requests, newest first.
 */

const mockState = {
  authenticated: true,
  uid: 'member-1',
  users: {} as Record<string, Record<string, unknown>>,
  leaves: [] as Array<Record<string, unknown>>,
  nextId: 1,
};

function compareValues(left: unknown, right: unknown): number {
  const normalize = (value: unknown): string | number => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? '';
  };
  const a = normalize(left);
  const b = normalize(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function makeLeaveCollection() {
  const filters: Array<{ field: string; op: string; value: unknown }> = [];
  let order: { field: string; direction: string } | null = null;
  const query: Record<string, unknown> = {
    where(field: string, op: string, value: unknown) {
      filters.push({ field, op, value });
      return query;
    },
    orderBy(field: string, direction = 'asc') {
      order = { field, direction };
      return query;
    },
    async get() {
      let docs = mockState.leaves.filter((doc) =>
        filters.every(({ field, op, value }) => {
          const actual = doc[field];
          if (op === '==') return actual === value;
          if (op === 'in') return Array.isArray(value) && value.includes(actual);
          if (op === '<=') return compareValues(actual, value) <= 0;
          if (op === '>=') return compareValues(actual, value) >= 0;
          if (op === '<') return compareValues(actual, value) < 0;
          if (op === '>') return compareValues(actual, value) > 0;
          return false;
        }),
      );
      if (order) {
        const { field, direction } = order;
        docs = [...docs].sort((a, b) => {
          const cmp = compareValues(a[field], b[field]);
          return direction === 'desc' ? -cmp : cmp;
        });
      }
      return {
        docs: docs.map((doc) => ({ id: doc.id, exists: true, data: () => ({ ...doc }) })),
        empty: docs.length === 0,
      };
    },
    async add(data: Record<string, unknown>) {
      const id = `leave-${mockState.nextId++}`;
      mockState.leaves.push({ id, ...data });
      return { id };
    },
    doc(id?: string) {
      const docId = id ?? `leave-${mockState.nextId++}`;
      return {
        id: docId,
        path: `leave_requests/${docId}`,
        async get() {
          const found = mockState.leaves.find((doc) => doc.id === docId);
          return { exists: found !== undefined, id: docId, data: () => (found ? { ...found } : undefined) };
        },
        async set(data: Record<string, unknown>) {
          const index = mockState.leaves.findIndex((doc) => doc.id === docId);
          if (index >= 0) mockState.leaves[index] = { id: docId, ...data };
          else mockState.leaves.push({ id: docId, ...data });
        },
        async update(patch: Record<string, unknown>) {
          const found = mockState.leaves.find((doc) => doc.id === docId);
          if (!found) throw new Error('Document not found');
          Object.assign(found, patch);
        },
      };
    },
  };
  return query;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'leave_requests') return makeLeaveCollection();
    if (name === 'users') {
      return {
        doc: (id: string) => ({
          id,
          path: `users/${id}`,
          async get() {
            const found = mockState.users[id];
            return { exists: found !== undefined, id, data: () => (found ? { ...found } : undefined) };
          },
        }),
      };
    }
    throw new Error(`Unexpected collection in leave route test: ${name}`);
  },
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () =>
    mockState.authenticated
      ? {
          authenticated: true,
          user: {
            userId: mockState.uid,
            email: 'member-1@example.com',
            displayName: 'Member One',
            emailVerified: true,
            role: 'member',
          },
        }
      : { authenticated: false, error: 'No authentication token provided', redirectTo: '/auth/login' },
  ),
}));

jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.name = 'SessionError';
      this.statusCode = statusCode;
    }
  }
  const failIfUnauthenticated = () => {
    if (!mockState.authenticated) throw new MockSessionError('Unauthorized: missing Bearer token', 401);
  };
  return {
    SessionError: MockSessionError,
    extractBearerToken: () => (mockState.authenticated ? 'test-bearer-token' : null),
    verifyIdTokenString: jest.fn(async () => {
      failIfUnauthenticated();
      return { uid: mockState.uid, email: 'member-1@example.com' };
    }),
    verifySession: jest.fn(async () => {
      failIfUnauthenticated();
      return { uid: mockState.uid, email: 'member-1@example.com' };
    }),
    toSessionErrorResponse: jest.fn(() => null),
  };
});

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
        delete: () => ({ __sentinel: 'delete' }),
        arrayUnion: (...values: unknown[]) => ({ __sentinel: 'arrayUnion', values }),
      },
      Timestamp: {
        now: () => ({ __sentinel: 'timestampNow' }),
        fromDate: (date: Date) => ({ __sentinel: 'timestampFromDate', date: date.toISOString() }),
      },
    },
    auth: () => ({
      verifyIdToken: async () => ({ uid: mockState.uid }),
    }),
  },
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
  getLastAdminError: jest.fn(() => null),
}));

import { GET, POST, PATCH } from '@/app/api/leave/route';
import { NextRequest } from 'next/server';

const CALLER_UID = 'member-1';
const OFFICER_UID = 'officer-1';
const OTHER_UID = 'other-1';

function isoDate(daysFromToday: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/leave', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    startDate: isoDate(5),
    endDate: isoDate(6),
    reason: 'Family event out of town',
    leaveType: 'annual',
    coveringOfficerId: OFFICER_UID,
    ...overrides,
  };
}

function seedLeave(overrides: Record<string, unknown> = {}) {
  const id = `leave-${mockState.nextId++}`;
  const doc = {
    id,
    userId: CALLER_UID,
    startDate: isoDate(5),
    endDate: isoDate(8),
    reason: 'Seeded leave',
    leaveType: 'annual',
    coveringOfficerId: OFFICER_UID,
    status: 'pending',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
  mockState.leaves.push(doc);
  return doc;
}

function storedLeave(id: string) {
  return mockState.leaves.find((doc) => doc.id === id);
}

beforeEach(() => {
  mockState.authenticated = true;
  mockState.uid = CALLER_UID;
  mockState.leaves = [];
  mockState.nextId = 1;
  mockState.users = {
    [CALLER_UID]: { displayName: 'Member One', email: 'member-1@example.com' },
    [OFFICER_UID]: { displayName: 'Officer One', email: 'officer-1@example.com' },
    [OTHER_UID]: { displayName: 'Other One', email: 'other-1@example.com' },
  };
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/leave', () => {
  it('rejects an unauthenticated request with 401 and writes nothing', async () => {
    mockState.authenticated = false;
    const res = await POST(makeRequest('POST', validBody()));
    expect(res.status).toBe(401);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('creates a valid request with status pending and no review fields', async () => {
    const res = await POST(makeRequest('POST', validBody()));
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status ?? 'pending').toBe('pending');
    expect(mockState.leaves).toHaveLength(1);
    const stored = mockState.leaves[0];
    expect(stored.userId).toBe(CALLER_UID);
    expect(stored.status).toBe('pending');
    expect(stored.reason).toBe('Family event out of town');
    expect(stored.startDate).toBe(isoDate(5));
    expect(stored.endDate).toBe(isoDate(6));
    expect(stored.leaveType).toBe('annual');
    expect(stored.coveringOfficerId).toBe(OFFICER_UID);
    expect(stored).toHaveProperty('createdAt');
    expect(stored).toHaveProperty('updatedAt');
    expect(stored).not.toHaveProperty('reviewedAt');
    expect(stored).not.toHaveProperty('reviewedBy');
    expect(stored).not.toHaveProperty('approvedBy');
  });

  it('forces userId to the caller when the body carries another userId', async () => {
    const res = await POST(makeRequest('POST', validBody({ userId: OTHER_UID })));
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(1);
    expect(mockState.leaves[0].userId).toBe(CALLER_UID);
  });

  it('forces status pending when the body carries status approved', async () => {
    const res = await POST(makeRequest('POST', validBody({ status: 'approved' })));
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(1);
    expect(mockState.leaves[0].status).toBe('pending');
    const body = await res.json();
    expect(body.status ?? 'pending').toBe('pending');
  });

  it('strips review fields from the stored doc', async () => {
    const res = await POST(
      makeRequest(
        'POST',
        validBody({
          reviewedAt: '2026-10-15T00:00:00.000Z',
          reviewedBy: 'someone-else',
          approvedBy: 'someone-else',
        }),
      ),
    );
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(1);
    const stored = mockState.leaves[0];
    expect(stored).not.toHaveProperty('reviewedAt');
    expect(stored).not.toHaveProperty('reviewedBy');
    expect(stored).not.toHaveProperty('approvedBy');
  });

  it('rejects endDate before startDate with 400 and writes nothing', async () => {
    const res = await POST(
      makeRequest('POST', validBody({ startDate: isoDate(6), endDate: isoDate(5) })),
    );
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects a startDate in the past with 400 and writes nothing', async () => {
    const res = await POST(
      makeRequest('POST', validBody({ startDate: isoDate(-1), endDate: isoDate(1) })),
    );
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects a missing or blank reason with 400 and writes nothing', async () => {
    const { reason: _omitted, ...noReason } = validBody();
    const missing = await POST(makeRequest('POST', noReason));
    expect(missing.status).toBe(400);
    const blank = await POST(makeRequest('POST', validBody({ reason: '   ' })));
    expect(blank.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects a reason over 500 characters with 400 and accepts exactly 500', async () => {
    const tooLong = await POST(makeRequest('POST', validBody({ reason: 'x'.repeat(501) })));
    expect(tooLong.status).toBe(400);
    const atLimit = await POST(makeRequest('POST', validBody({ reason: 'x'.repeat(500) })));
    expect([200, 201]).toContain(atLimit.status);
    expect(mockState.leaves).toHaveLength(1);
  });

  it('rejects an unknown leaveType with 400 and writes nothing', async () => {
    const res = await POST(makeRequest('POST', validBody({ leaveType: 'vacation' })));
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it.each(['annual', 'sick', 'emergency', 'exam', 'personal'])(
    'accepts leaveType %s',
    async (leaveType) => {
      const res = await POST(makeRequest('POST', validBody({ leaveType })));
      expect([200, 201]).toContain(res.status);
      expect(mockState.leaves[0].leaveType).toBe(leaveType);
    },
  );

  it('rejects a missing startDate or endDate with 400 and writes nothing', async () => {
    const { startDate: _start, ...noStart } = validBody();
    expect((await POST(makeRequest('POST', noStart))).status).toBe(400);
    const { endDate: _end, ...noEnd } = validBody();
    expect((await POST(makeRequest('POST', noEnd))).status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects unparseable dates with 400 and writes nothing', async () => {
    const res = await POST(
      makeRequest('POST', validBody({ startDate: 'not-a-date', endDate: 'also-not-a-date' })),
    );
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects a covering officer equal to the requester with 400 and writes nothing', async () => {
    const res = await POST(makeRequest('POST', validBody({ coveringOfficerId: CALLER_UID })));
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects a covering officer who does not exist with 400 and writes nothing', async () => {
    const res = await POST(makeRequest('POST', validBody({ coveringOfficerId: 'ghost-user' })));
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('rejects a leave overlapping an existing pending leave with 409 and writes nothing', async () => {
    seedLeave({ startDate: isoDate(5), endDate: isoDate(8), status: 'pending' });
    const res = await POST(
      makeRequest('POST', validBody({ startDate: isoDate(7), endDate: isoDate(10) })),
    );
    expect(res.status).toBe(409);
    expect(mockState.leaves).toHaveLength(1);
  });

  it('rejects a leave overlapping an existing approved leave with 409 and writes nothing', async () => {
    seedLeave({ startDate: isoDate(5), endDate: isoDate(8), status: 'approved' });
    const res = await POST(
      makeRequest('POST', validBody({ startDate: isoDate(7), endDate: isoDate(10) })),
    );
    expect(res.status).toBe(409);
    expect(mockState.leaves).toHaveLength(1);
  });

  it('allows a leave that only overlaps a cancelled leave', async () => {
    seedLeave({ startDate: isoDate(5), endDate: isoDate(8), status: 'cancelled' });
    const res = await POST(
      makeRequest(
        'POST',
        validBody({ startDate: isoDate(6), endDate: isoDate(7), coveringOfficerId: undefined }),
      ),
    );
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(2);
  });

  it('allows a leave starting the day after an existing leave ends', async () => {
    seedLeave({ startDate: isoDate(5), endDate: isoDate(8), status: 'approved' });
    const res = await POST(
      makeRequest(
        'POST',
        validBody({ startDate: isoDate(9), endDate: isoDate(10), coveringOfficerId: undefined }),
      ),
    );
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(2);
  });

  it('requires a covering officer when the leave is longer than 3 days', async () => {
    const { coveringOfficerId: _officer, ...noOfficer } = validBody();
    const res = await POST(
      makeRequest('POST', { ...noOfficer, startDate: isoDate(5), endDate: isoDate(8) }),
    );
    expect(res.status).toBe(400);
    expect(mockState.leaves).toHaveLength(0);
  });

  it('allows a 3 day leave without a covering officer', async () => {
    const { coveringOfficerId: _officer, ...noOfficer } = validBody();
    const res = await POST(
      makeRequest('POST', { ...noOfficer, startDate: isoDate(5), endDate: isoDate(7) }),
    );
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(1);
  });

  it('allows a 1 day leave without a covering officer', async () => {
    const { coveringOfficerId: _officer, ...noOfficer } = validBody();
    const res = await POST(
      makeRequest('POST', { ...noOfficer, startDate: isoDate(5), endDate: isoDate(5) }),
    );
    expect([200, 201]).toContain(res.status);
    expect(mockState.leaves).toHaveLength(1);
  });
});

describe('GET /api/leave', () => {
  it('rejects an unauthenticated request with 401', async () => {
    mockState.authenticated = false;
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
  });

  it('returns only the caller own docs, including approved ones', async () => {
    const ownPending = seedLeave({ status: 'pending', createdAt: '2026-10-10T00:00:00.000Z' });
    const ownApproved = seedLeave({
      status: 'approved',
      startDate: isoDate(12),
      endDate: isoDate(13),
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    seedLeave({ userId: OTHER_UID, status: 'pending', createdAt: '2026-10-12T00:00:00.000Z' });
    seedLeave({ userId: OTHER_UID, status: 'approved', createdAt: '2026-10-13T00:00:00.000Z' });
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.requests;
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((doc: Record<string, unknown>) => doc.id).sort()).toEqual(
      [ownPending.id, ownApproved.id].sort(),
    );
    expect(list.every((doc: Record<string, unknown>) => doc.userId === CALLER_UID)).toBe(true);
  });

  it('returns the caller requests newest first', async () => {
    seedLeave({ status: 'pending', createdAt: '2026-10-10T00:00:00.000Z' });
    const newer = seedLeave({
      status: 'pending',
      startDate: isoDate(12),
      endDate: isoDate(13),
      createdAt: '2026-10-12T00:00:00.000Z',
    });
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.requests;
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(newer.id);
  });

  it('returns an empty list when the caller has no requests', async () => {
    seedLeave({ userId: OTHER_UID, status: 'pending' });
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.requests;
    expect(list).toEqual([]);
  });
});

describe('PATCH /api/leave cancel', () => {
  it('rejects an unauthenticated request with 401 and changes nothing', async () => {
    const seeded = seedLeave({ status: 'pending' });
    mockState.authenticated = false;
    const res = await PATCH(makeRequest('PATCH', { action: 'cancel', id: seeded.id }));
    expect(res.status).toBe(401);
    expect(storedLeave(seeded.id)?.status).toBe('pending');
  });

  it('cancels the caller own pending leave', async () => {
    const seeded = seedLeave({ status: 'pending' });
    const res = await PATCH(makeRequest('PATCH', { action: 'cancel', id: seeded.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status ?? 'cancelled').toBe('cancelled');
    expect(storedLeave(seeded.id)?.status).toBe('cancelled');
  });

  it('rejects cancelling a non-pending leave with 409 and leaves the doc unchanged', async () => {
    const seeded = seedLeave({ status: 'approved' });
    const res = await PATCH(makeRequest('PATCH', { action: 'cancel', id: seeded.id }));
    expect(res.status).toBe(409);
    expect(storedLeave(seeded.id)?.status).toBe('approved');
  });

  it('rejects cancelling someone else leave with 403 and leaves the doc unchanged', async () => {
    const seeded = seedLeave({ userId: OTHER_UID, status: 'pending' });
    const res = await PATCH(makeRequest('PATCH', { action: 'cancel', id: seeded.id }));
    expect(res.status).toBe(403);
    expect(storedLeave(seeded.id)?.status).toBe('pending');
  });

  it('returns 404 for an unknown leave id', async () => {
    const res = await PATCH(makeRequest('PATCH', { action: 'cancel', id: 'no-such-id' }));
    expect(res.status).toBe(404);
  });

  it('rejects non-cancel PATCH actions with 400 and changes nothing', async () => {
    const seeded = seedLeave({ status: 'pending' });
    const res = await PATCH(makeRequest('PATCH', { action: 'approve', id: seeded.id }));
    expect(res.status).toBe(400);
    expect(storedLeave(seeded.id)?.status).toBe('pending');
  });
});
