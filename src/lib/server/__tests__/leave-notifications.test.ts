/**
 * @jest-environment node
 *
 * Unit tests for src/lib/server/leave-notifications.ts, the submission
 * fan-out for leave requests (defect: submitting used to notify
 * nobody).
 *
 * Covered:
 * - Reviewer recipients are exactly the holders of roles that grant
 *   canManageApplications, resolved through hasServerPermission over
 *   the role catalog candidates and enumerated across the roles and
 *   users stores (role, displayRole, additionalRoles), deduped, with
 *   the requester excluded.
 * - The reviewer notice carries the member name and the leave dates.
 * - The covering officer is notified only when one is named.
 * - Holders of non-granting roles receive nothing.
 * - The recipient set is capped at MAX_LEAVE_REVIEW_RECIPIENTS.
 *
 * hasServerPermission, the Firebase admin handle, and the
 * notifications Supabase seam are mocked; Firestore is an in-memory
 * fake supporting the where/get and doc/collection/set shapes the
 * helper uses.
 */

const mockGrantingSlugs = new Set<string>();
const mockMirrorCreate = jest.fn(async () => {});

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
      },
      Timestamp: {
        now: () => ({ __sentinel: 'timestampNow' }),
      },
    },
  },
  getDb: jest.fn(() => null),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (slug: string) => mockGrantingSlugs.has(slug)),
}));

jest.mock('@/lib/server/notifications-supa-seam', () => ({
  mirrorNotificationCreate: (...args: unknown[]) => mockMirrorCreate(...(args as [])),
  userNotificationsPath: (uid: string) => `users/${uid}/notifications`,
}));

interface FakePerson {
  id: string;
  role?: string;
  displayRole?: string;
  additionalRoles?: string[];
}

const mockState = {
  roleDefinitionIds: [] as string[],
  permissionIds: [] as string[],
  roles: [] as FakePerson[],
  users: [] as FakePerson[],
  notifications: {} as Record<string, Array<Record<string, unknown>>>,
  nextNotifId: 1,
};

function matchesFilters(person: FakePerson, filters: Array<{ field: string; op: string; value: unknown }>) {
  return filters.every(({ field, op, value }) => {
    const actual = (person as Record<string, unknown>)[field];
    if (op === '==') return actual === value;
    if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value);
    return false;
  });
}

function makePeopleCollection(people: () => FakePerson[]) {
  return {
    where(field: string, op: string, value: unknown) {
      const filters = [{ field, op, value }];
      const query = {
        where(f2: string, op2: string, v2: unknown) {
          filters.push({ field: f2, op: op2, value: v2 });
          return query;
        },
        async get() {
          const docs = people()
            .filter((p) => matchesFilters(p, filters))
            .map((p) => ({ id: p.id, data: () => ({ ...p }) }));
          return { docs, empty: docs.length === 0 };
        },
      };
      return query;
    },
    doc(id: string) {
      return {
        id,
        collection(name: string) {
          if (name !== 'notifications') throw new Error(`Unexpected subcollection: ${name}`);
          return {
            doc() {
              const notifId = `notif-${mockState.nextNotifId++}`;
              return {
                id: notifId,
                async set(data: Record<string, unknown>) {
                  (mockState.notifications[id] ||= []).push({ id: notifId, ...data });
                },
              };
            },
          };
        },
      };
    },
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'roleDefinitions' || name === 'permissions') {
      const ids = name === 'roleDefinitions' ? mockState.roleDefinitionIds : mockState.permissionIds;
      return {
        async get() {
          return { docs: ids.map((id) => ({ id, data: () => ({}) })), empty: ids.length === 0 };
        },
      };
    }
    if (name === 'roles') return makePeopleCollection(() => mockState.roles);
    if (name === 'users') return makePeopleCollection(() => mockState.users);
    throw new Error(`Unexpected collection: ${name}`);
  },
};

import {
  findLeaveReviewerUids,
  notifyLeaveSubmitted,
  MAX_LEAVE_REVIEW_RECIPIENTS,
} from '@/lib/server/leave-notifications';

const REQUESTER = 'member-1';
const OFFICER = 'officer-1';

function baseNotice(overrides: Record<string, unknown> = {}) {
  return {
    leaveRequestId: 'leave-1',
    requesterUid: REQUESTER,
    requesterName: 'Member One',
    leaveType: 'annual',
    startDate: '2026-11-02',
    endDate: '2026-11-06',
    coveringOfficerId: OFFICER,
    ...overrides,
  };
}

beforeEach(() => {
  mockGrantingSlugs.clear();
  mockGrantingSlugs.add('chapter_secretary');
  mockMirrorCreate.mockClear();
  mockState.roleDefinitionIds = ['chapter_secretary', 'member_basic'];
  mockState.permissionIds = ['chapter_secretary'];
  mockState.roles = [
    { id: 'admin-a', role: 'chapter_secretary' },
    { id: 'member-2', role: 'member_basic' },
  ];
  mockState.users = [
    { id: REQUESTER, role: 'member_basic', displayName: 'Member One' } as FakePerson,
    { id: 'admin-b', role: 'member_basic', displayRole: 'chapter_secretary' },
    { id: 'admin-c', role: 'member_basic', additionalRoles: ['chapter_secretary'] },
    { id: 'admin-a', role: 'chapter_secretary' },
    { id: OFFICER, role: 'member_basic' },
  ];
  mockState.notifications = {};
  mockState.nextNotifId = 1;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('findLeaveReviewerUids', () => {
  it('collects holders of granting roles across both stores, deduped', async () => {
    const uids = await findLeaveReviewerUids(mockDb as never);
    expect(uids.sort()).toEqual(['admin-a', 'admin-b', 'admin-c']);
  });

  it('excludes the requester even when they hold a granting role', async () => {
    mockState.roles.push({ id: REQUESTER, role: 'chapter_secretary' });
    const uids = await findLeaveReviewerUids(mockDb as never, REQUESTER);
    expect(uids).not.toContain(REQUESTER);
    expect(uids.sort()).toEqual(['admin-a', 'admin-b', 'admin-c']);
  });

  it('returns an empty list when no role grants the permission', async () => {
    mockGrantingSlugs.clear();
    const uids = await findLeaveReviewerUids(mockDb as never);
    expect(uids).toEqual([]);
  });
});

describe('notifyLeaveSubmitted', () => {
  it('writes the review notice with member name and dates to every reviewer', async () => {
    const result = await notifyLeaveSubmitted(mockDb as never, baseNotice());
    expect(result.reviewerCount).toBe(3);
    for (const uid of ['admin-a', 'admin-b', 'admin-c']) {
      const notices = mockState.notifications[uid] || [];
      expect(notices).toHaveLength(1);
      expect(notices[0].type).toBe('leave_request_submitted');
      expect(notices[0].title).toBe('Leave Request Awaiting Review');
      expect(String(notices[0].body)).toContain('Member One');
      expect(String(notices[0].body)).toContain('2026-11-02');
      expect(String(notices[0].body)).toContain('2026-11-06');
      expect(String(notices[0].body)).toContain('Annual leave');
      expect(notices[0].link).toBe('/admin/submissions');
      expect(notices[0].isRead).toBe(false);
    }
    // The requester and ordinary members get no review notice.
    expect(mockState.notifications[REQUESTER]).toBeUndefined();
    expect(mockState.notifications['member-2']).toBeUndefined();
  });

  it('notifies the covering officer when one is named', async () => {
    const result = await notifyLeaveSubmitted(mockDb as never, baseNotice());
    expect(result.coveringOfficerNotified).toBe(true);
    const notices = mockState.notifications[OFFICER] || [];
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe('leave_covering_officer_named');
    expect(String(notices[0].body)).toContain('Member One');
    expect(String(notices[0].body)).toContain('2026-11-02');
    expect(String(notices[0].body)).toContain('2026-11-06');
  });

  it('does not notify a covering officer when none is named', async () => {
    const result = await notifyLeaveSubmitted(
      mockDb as never,
      baseNotice({ coveringOfficerId: null }),
    );
    expect(result.coveringOfficerNotified).toBe(false);
    expect(mockState.notifications[OFFICER]).toBeUndefined();
    expect(result.reviewerCount).toBe(3);
  });

  it('mirrors every written notification through the seam', async () => {
    await notifyLeaveSubmitted(mockDb as never, baseNotice());
    // 3 reviewers + 1 covering officer.
    expect(mockMirrorCreate).toHaveBeenCalledTimes(4);
    const paths = mockMirrorCreate.mock.calls.map((c) => (c as unknown[])[0]);
    expect(paths).toContain('users/admin-a/notifications');
    expect(paths).toContain(`users/${OFFICER}/notifications`);
  });

  it('caps the reviewer fan-out at MAX_LEAVE_REVIEW_RECIPIENTS', async () => {
    mockState.users = Array.from({ length: MAX_LEAVE_REVIEW_RECIPIENTS + 25 }, (_, i) => ({
      id: `holder-${i}`,
      role: 'chapter_secretary',
    }));
    const result = await notifyLeaveSubmitted(
      mockDb as never,
      baseNotice({ coveringOfficerId: null }),
    );
    expect(result.reviewerCount).toBe(MAX_LEAVE_REVIEW_RECIPIENTS);
  });
});
