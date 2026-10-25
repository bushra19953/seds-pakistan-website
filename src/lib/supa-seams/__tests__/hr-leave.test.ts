/**
 * @jest-environment node
 *
 * Unit tests for the HR leave Supabase seam (src/lib/supa-seams/hr-leave.ts).
 * The adapter is a mocked fake -- no live Supabase or Firestore calls.
 * Covers: flag on/off/'*', null adapter (client unset), adapter error
 * fallback signalling, shape identity of returned docs, timestamp
 * conversions both ways, and dual-write mirror behaviour.
 */

import {
  getAdapter,
  getLeaveRequestForReview,
  isLeaveSupaEnabled,
  listLeaveRequestsForReview,
  mirrorLeaveAuditSet,
  mirrorLeaveRequestSet,
  mirrorLeaveRequestUpdate,
  resetAdapterForTests,
  serializeDataForSupa,
  setAdapterForTests,
  toTimestampLike,
  tryGetLeaveRequest,
  tryListLeaveRequests,
  useSupa,
  type SupaAdapter,
  type SupaDoc,
} from '@/lib/supa-seams/hr-leave';

const LEAVE_DOC: SupaDoc = {
  id: 'leave-1',
  userId: 'member-1',
  reason: 'Family event',
  startDate: '2026-11-01',
  endDate: '2026-11-02',
  leaveType: 'annual',
  coveringOfficerId: 'officer-1',
  coveringOfficerName: 'Officer One',
  notes: null,
  status: 'approved',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T11:00:00.000Z',
  reviewedAt: '2026-10-21T11:00:00.000Z',
  reviewedBy: 'admin-1',
};

function makeAdapter(overrides: Partial<SupaAdapter> = {}): SupaAdapter {
  return {
    getDoc: jest.fn(async () => ({ ...LEAVE_DOC })),
    listDocs: jest.fn(async () => [{ ...LEAVE_DOC }]),
    countDocs: jest.fn(async () => 1),
    setDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    updateDoc: jest.fn(async (_c: string, id: string, data: Record<string, unknown>) => ({ id, ...data })),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

const ENV_KEY = 'SUPA_SURFACES';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  resetAdapterForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  resetAdapterForTests();
  jest.restoreAllMocks();
});

describe('flag gate', () => {
  it('is OFF when SUPA_SURFACES is unset, even with an adapter', () => {
    setAdapterForTests(makeAdapter());
    expect(useSupa('leave')).toBe(false);
    expect(isLeaveSupaEnabled()).toBe(false);
    expect(getAdapter()).not.toBeNull();
  });

  it('is OFF for other surfaces only', () => {
    process.env[ENV_KEY] = 'tasks,announcements';
    setAdapterForTests(makeAdapter());
    expect(isLeaveSupaEnabled()).toBe(false);
  });

  it('is ON for leave (case-insensitive, whitespace tolerant)', () => {
    process.env[ENV_KEY] = ' Tasks , LEAVE ';
    setAdapterForTests(makeAdapter());
    expect(useSupa('leave')).toBe(true);
    expect(isLeaveSupaEnabled()).toBe(true);
  });

  it('is ON for *', () => {
    process.env[ENV_KEY] = '*';
    setAdapterForTests(makeAdapter());
    expect(isLeaveSupaEnabled()).toBe(true);
  });

  it('is OFF when the flag is ON but the adapter is null (client unset)', () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(null);
    expect(getAdapter()).toBeNull();
    expect(isLeaveSupaEnabled()).toBe(false);
  });

  it('getAdapter returns null by default in this branch (merge not landed)', () => {
    process.env[ENV_KEY] = 'leave';
    expect(getAdapter()).toBeNull();
    expect(isLeaveSupaEnabled()).toBe(false);
  });
});

describe('reads', () => {
  it('returns disabled when the flag is OFF and never calls the adapter', async () => {
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const result = await tryGetLeaveRequest('leave-1');
    expect(result.status).toBe('disabled');
    expect(adapter.getDoc).not.toHaveBeenCalled();
  });

  it('returns disabled when the adapter is null even with the flag ON', async () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(null);
    const result = await tryListLeaveRequests();
    expect(result.status).toBe('disabled');
  });

  it('returns the doc with shape identity and converted timestamps when ON', async () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(makeAdapter());
    const result = await tryGetLeaveRequest('leave-1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || !result.value) throw new Error('expected ok doc');
    const doc = result.value;
    // Non-timestamp fields are byte-identical to the adapter payload.
    expect(doc.id).toBe('leave-1');
    expect(doc.userId).toBe('member-1');
    expect(doc.reason).toBe('Family event');
    expect(doc.startDate).toBe('2026-11-01');
    expect(doc.endDate).toBe('2026-11-02');
    expect(doc.leaveType).toBe('annual');
    expect(doc.status).toBe('approved');
    expect(doc.reviewedBy).toBe('admin-1');
    // Timestamp fields become Timestamp-like with the same instant.
    const createdAt = doc.createdAt as { toDate: () => Date; toISOString: () => string };
    expect(typeof createdAt.toDate).toBe('function');
    expect(createdAt.toDate().toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(createdAt.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    const reviewedAt = doc.reviewedAt as { toDate: () => Date };
    expect(reviewedAt.toDate().toISOString()).toBe('2026-10-21T11:00:00.000Z');
  });

  it('passes a null doc through as ok/null (not found)', async () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(makeAdapter({ getDoc: jest.fn(async () => null) }));
    const result = await tryGetLeaveRequest('missing');
    expect(result).toEqual({ status: 'ok', value: null });
  });

  it('signals error (caller falls back to Firestore) when the adapter throws', async () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(
      makeAdapter({
        getDoc: jest.fn(async () => {
          throw new Error('supa down');
        }),
        listDocs: jest.fn(async () => {
          throw new Error('supa down');
        }),
      }),
    );
    const single = await tryGetLeaveRequest('leave-1');
    expect(single.status).toBe('error');
    const list = await tryListLeaveRequests();
    expect(list.status).toBe('error');
  });

  it('list forwards where/orderBy on data fields and converts timestamps', async () => {
    process.env[ENV_KEY] = 'leave';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const result = await tryListLeaveRequests({
      where: [
        ['userId', '==', 'member-1'],
        ['status', 'in', ['pending', 'approved']],
      ],
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    expect(result.status).toBe('ok');
    expect(adapter.listDocs).toHaveBeenCalledWith('leave_requests', {
      where: [
        ['userId', '==', 'member-1'],
        ['status', 'in', ['pending', 'approved']],
      ],
      orderBy: { field: 'createdAt', direction: 'desc' },
    });
    if (result.status !== 'ok') throw new Error('expected ok');
    const createdAt = result.value[0].createdAt as { toISOString: () => string };
    expect(createdAt.toISOString()).toBe('2026-10-20T10:00:00.000Z');
  });

  it('universal-review readers query leave_requests by status with a 100 limit', async () => {
    process.env[ENV_KEY] = 'leave';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    const list = await listLeaveRequestsForReview({ status: 'pending' });
    expect(list.status).toBe('ok');
    expect(adapter.listDocs).toHaveBeenCalledWith('leave_requests', {
      where: [['status', '==', 'pending']],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 100,
    });
    const single = await getLeaveRequestForReview('leave-1');
    expect(single.status).toBe('ok');
    expect(adapter.getDoc).toHaveBeenCalledWith('leave_requests', 'leave-1');
  });
});

describe('timestamp conversion helpers', () => {
  it('toTimestampLike converts an ISO string and leaves other values untouched', () => {
    const converted = toTimestampLike('2026-10-20T10:00:00.000Z') as {
      toDate: () => Date;
      toMillis: () => number;
      seconds: number;
    };
    expect(converted.toDate().toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(converted.toMillis()).toBe(Date.parse('2026-10-20T10:00:00.000Z'));
    expect(converted.seconds).toBe(Math.floor(Date.parse('2026-10-20T10:00:00.000Z') / 1000));
    expect(toTimestampLike('not-a-date')).toBe('not-a-date');
    expect(toTimestampLike(42)).toBe(42);
    expect(toTimestampLike(null)).toBeNull();
  });

  it('serializeDataForSupa converts Dates, Timestamp-likes and serverTimestamp sentinels to ISO strings and drops delete sentinels', () => {
    const out = serializeDataForSupa({
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
      reviewedAt: { toDate: () => new Date('2026-10-21T11:00:00.000Z') },
      updatedAt: { __sentinel: 'serverTimestamp' },
      leaveRequestId: { __sentinel: 'delete' },
      status: 'pending',
      count: 3,
    });
    expect(out.createdAt).toBe('2026-10-20T10:00:00.000Z');
    expect(out.reviewedAt).toBe('2026-10-21T11:00:00.000Z');
    expect(typeof out.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(out.updatedAt as string))).toBe(false);
    expect(out).not.toHaveProperty('leaveRequestId');
    expect(out.status).toBe('pending');
    expect(out.count).toBe(3);
  });
});

describe('dual-write mirrors', () => {
  it('does nothing when the flag is OFF', async () => {
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    await expect(mirrorLeaveRequestSet('leave-1', { status: 'pending' })).resolves.toBe(false);
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });

  it('does nothing when the adapter is null even with the flag ON', async () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(null);
    await expect(mirrorLeaveRequestUpdate('leave-1', { status: 'cancelled' })).resolves.toBe(false);
    await expect(mirrorLeaveAuditSet('audit-1', { action: 'leave_returned' })).resolves.toBe(false);
  });

  it('mirrors set/update/audit to the leave collections with serialized timestamps when ON', async () => {
    process.env[ENV_KEY] = 'leave';
    const adapter = makeAdapter();
    setAdapterForTests(adapter);
    await expect(
      mirrorLeaveRequestSet('leave-1', {
        status: 'pending',
        createdAt: { __sentinel: 'serverTimestamp' },
      }),
    ).resolves.toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledWith(
      'leave_requests',
      'leave-1',
      expect.objectContaining({ status: 'pending', createdAt: expect.any(String) }),
    );
    await expect(
      mirrorLeaveRequestUpdate('leave-1', { status: 'cancelled' }),
    ).resolves.toBe(true);
    expect(adapter.updateDoc).toHaveBeenCalledWith('leave_requests', 'leave-1', {
      status: 'cancelled',
    });
    await expect(
      mirrorLeaveAuditSet('audit-1', { action: 'leave_returned', targetUid: 'member-1' }),
    ).resolves.toBe(true);
    expect(adapter.setDoc).toHaveBeenCalledWith('leave_audit', 'audit-1', {
      action: 'leave_returned',
      targetUid: 'member-1',
    });
  });

  it('swallows adapter errors and reports false (Firestore stays primary)', async () => {
    process.env[ENV_KEY] = 'leave';
    setAdapterForTests(
      makeAdapter({
        setDoc: jest.fn(async () => {
          throw new Error('supa down');
        }),
        updateDoc: jest.fn(async () => {
          throw new Error('supa down');
        }),
      }),
    );
    await expect(mirrorLeaveRequestSet('leave-1', { status: 'pending' })).resolves.toBe(false);
    await expect(mirrorLeaveRequestUpdate('leave-1', { status: 'x' })).resolves.toBe(false);
    await expect(mirrorLeaveAuditSet('audit-1', { action: 'x' })).resolves.toBe(false);
  });
});
