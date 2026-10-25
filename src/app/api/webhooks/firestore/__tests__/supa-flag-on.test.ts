/**
 * @jest-environment node
 *
 * G5 flag-ON tests for POST /api/webhooks/firestore: when the
 * 'webhooks' surface is ON, the route's POST entry obtains its db from
 * the group seam (src/lib/server/webhooks/supa-handle.ts), which returns
 * the foundation handle over the Supabase adapter. These tests drive
 * the REAL route + REAL seam + REAL handle against the adapter's
 * in-memory FakeSupa and assert the write sets land in the fs_* tables.
 *
 * The foundation gate itself (supaDbHandleFor) is mocked at its module
 * boundary: it returns a handle built over FakeSupa when the test arms
 * the flag, and null when disarmed (flag OFF / no client), which is
 * exactly the seam's fallback trigger. Firebase Auth and FCM stay on
 * their (mocked) real APIs — they are not data (plan C-G5-2 / C-G5-4).
 * FieldValue is the REAL firebase-admin module so the handle's
 * structural sentinel detection sees genuine transform objects.
 * Zero live calls; no real credential values anywhere.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// Mutable per-test state. The `mock` prefix is required for variables
// referenced inside jest.mock factories.
const mockState = {
  supaHandle: null as any,
  surfaces: [] as string[],
  claims: [] as Array<{ uid: string; claims: any }>,
  messages: [] as any[],
  firestoreCalls: [] as Array<{ op: string; path: string; data?: any; opts?: any }>,
};

function mockDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => ({
      exists: true,
      data: () => ({ chapterId: 'ch-1', displayName: 'User One', photoURL: 'pic-1' }),
    }),
    update: async (data: any) => {
      mockState.firestoreCalls.push({ op: 'update', path, data });
    },
    set: async (data: any, opts?: any) => {
      mockState.firestoreCalls.push({ op: 'set', path, data, opts });
    },
    delete: async () => {
      mockState.firestoreCalls.push({ op: 'delete', path });
    },
    collection: (sub: string) => ({
      add: async (data: any) => {
        mockState.firestoreCalls.push({ op: 'add', path: `${path}/${sub}`, data });
        return { id: 'generated-sub-id' };
      },
      doc: (subId?: string) => mockDocRef(`${path}/${sub}/${subId ?? 'auto-id'}`),
    }),
  };
}

const mockFirestoreDb = {
  collection: (name: string) => ({
    doc: (id?: string) => mockDocRef(`${name}/${id ?? 'auto-id'}`),
    add: async (data: any) => {
      mockState.firestoreCalls.push({ op: 'add', path: name, data });
      return { id: 'generated-id' };
    },
    get: async () => ({ docs: [] }),
    where: () => ({ get: async () => ({ docs: [] }) }),
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) =>
      mockState.firestoreCalls.push({ op: 'batch-set', path: ref.path, data, opts }),
    update: (ref: any, data: any) =>
      mockState.firestoreCalls.push({ op: 'batch-update', path: ref.path, data }),
    delete: (ref: any) => mockState.firestoreCalls.push({ op: 'batch-delete', path: ref.path }),
    commit: async () => {
      mockState.firestoreCalls.push({ op: 'batch-commit', path: '' });
    },
  }),
  runTransaction: async (fn: any) =>
    fn({
      get: async () => ({ data: () => null }),
      update: (ref: any, data: any) =>
        mockState.firestoreCalls.push({ op: 'tx-update', path: ref.path, data }),
      set: (ref: any, data: any, opts?: any) =>
        mockState.firestoreCalls.push({ op: 'tx-set', path: ref.path, data, opts }),
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

jest.mock('@/lib/server/firebase-admin', () => ({
  admin: {},
  getDb: () => mockFirestoreDb,
}));

// Mock ONLY the foundation gate; the handle class, the adapter and the
// seam under test are the real implementations.
jest.mock('@/lib/server/supa-db-handle', () => {
  const actual = jest.requireActual('@/lib/server/supa-db-handle');
  return {
    ...actual,
    supaDbHandleFor: (surface: string) => {
      mockState.surfaces.push(surface);
      return mockState.supaHandle;
    },
  };
});

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: (mockState as any).customClaims?.[uid] ?? {} }),
    setCustomUserClaims: async (uid: string, claims: any) => {
      mockState.claims.push({ uid, claims });
    },
  }),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({
    sendEachForMulticast: async (message: any) => {
      mockState.messages.push(message);
      return {};
    },
  }),
}));

import { POST } from '../route';
import { createSupaAdapter } from '@/lib/supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';

const SECRET = 'test-webhook-secret';

let fake: FakeSupa;

function whRequest(body: any): any {
  return new Request('http://localhost/api/webhooks/firestore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  fake = new FakeSupa();
  const adapter = createSupaAdapter(fake as unknown as SupabaseClient);
  mockState.supaHandle = createSupaDbHandle(adapter);
  mockState.surfaces = [];
  mockState.claims = [];
  mockState.messages = [];
  mockState.firestoreCalls = [];
  process.env.FIRESTORE_WEBHOOK_SECRET = SECRET;
});

describe("flag ON ('webhooks') — write sets land in the fs_* tables", () => {
  it('(a) tasks create → assignee notifications batch + creator activity add + universal sync row', async () => {
    fake.seed('fs_users', [
      landingRow('u-1', { displayName: 'User One', photoURL: 'pic-1', chapterId: 'ch-1' }, 'users', 'u-1'),
    ]);
    const res: any = await POST(
      whRequest({
        collection: 'tasks',
        docId: 'task-1',
        eventType: 'create',
        before: null,
        after: { title: 'Build Rover', createdBy: 'creator-1', assigneeIds: ['u-1', 'u-2'], status: 'pending' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockState.surfaces).toEqual(['webhooks']);
    // The Firestore fallback db was never touched.
    expect(mockState.firestoreCalls).toHaveLength(0);

    const activity = fake.rows('fs_group_activity');
    expect(activity).toHaveLength(1);
    expect(activity[0].parent_path).toBe('users/creator-1/activity');
    expect(activity[0].data).toMatchObject({ type: 'taskCreated', taskId: 'task-1', taskTitle: 'Build Rover' });
    // new Date() writes are stored as ISO strings by the adapter.
    expect(typeof activity[0].data.createdAt).toBe('string');
    expect(Number.isFinite(Date.parse(activity[0].data.createdAt as string))).toBe(true);

    const notifs = fake.rows('fs_group_notifications');
    expect(notifs.map((n) => n.parent_path).sort()).toEqual([
      'users/u-1/notifications',
      'users/u-2/notifications',
    ]);
    for (const n of notifs) {
      expect(n.data).toMatchObject({
        type: 'task-assigned',
        title: 'New Task Assigned',
        body: 'You have been assigned a new task: "Build Rover"',
        taskId: 'task-1',
        isRead: false,
        priority: 'P1',
        link: '/tasks/task-1',
      });
      expect(n.data.userId).toBe(String(n.parent_path).split('/')[1]);
      expect(typeof n.data.createdAt).toBe('string');
    }

    const sync = fake.rows('fs_universal_submissions');
    expect(sync).toHaveLength(1);
    expect(sync[0].id).toBe('tasks_task-1');
    expect(sync[0].data).toMatchObject({
      global_id: 'tasks_task-1',
      original_ref: 'tasks/task-1',
      type: 'TASK_REVIEW',
      status: 'PENDING',
      user_id: 'u-1',
      user_display_name: 'User One',
      user_photo_url: 'pic-1',
      chapter_id: 'ch-1',
      summary_text: 'Task Review: Build Rover',
    });
    // No createdAt in the payload: FieldValue.serverTimestamp() in the
    // priority chain resolves through the handle to a stored ISO string.
    expect(typeof sync[0].data.created_at).toBe('string');
    expect(Number.isFinite(Date.parse(sync[0].data.created_at as string))).toBe(true);
  });

  it('(b) tasks completion → reward transaction writes, and a second delivery awards NO points (rewardApplied idempotency)', async () => {
    fake.seed('fs_tasks', [
      landingRow(
        'task-1',
        {
          title: 'Tx Task',
          points: 30,
          hoursWorked: 2,
          completionBadgeId: 'badge-1',
          assigneeIds: ['u-1'],
          deadline: new Date(Date.now() + 86400000).toISOString(),
          status: 'in-progress',
        },
        'tasks',
      ),
    ]);
    fake.seed('fs_users', [
      landingRow(
        'u-1',
        {
          points: 10,
          totalHoursWorked: 5,
          tasksCompletedCount: 2,
          tasksCompletedOnTimeCount: 1,
          badges: [] as string[],
          displayName: 'User One',
          photoURL: 'pic-1',
          chapterId: 'ch-1',
        },
        'users',
        'u-1',
      ),
    ]);
    const body = {
      collection: 'tasks',
      docId: 'task-1',
      eventType: 'update',
      before: { status: 'in-progress' },
      after: { status: 'completed', title: 'Tx Task', assigneeIds: ['u-1'] },
    };

    const res: any = await POST(whRequest(body));
    expect(res.status).toBe(200);

    const user = fake.rows('fs_users')[0].data;
    expect(user.points).toBe(40);
    expect(user.totalHoursWorked).toBe(7);
    expect(user.tasksCompletedCount).toBe(3);
    expect(user.tasksCompletedOnTimeCount).toBe(2);
    expect(user.badges).toEqual(['badge-1']);
    expect(typeof user.lastTaskCompletedAt).toBe('string');

    const rewards = fake.rows('fs_group_rewards');
    expect(rewards).toHaveLength(1);
    expect(rewards[0].id).toBe('task-1');
    expect(rewards[0].parent_path).toBe('users/u-1/rewards');
    expect(rewards[0].data).toMatchObject({
      taskId: 'task-1',
      pointsAwarded: 30,
      hoursAwarded: 2,
      badgeId: 'badge-1',
      onTime: true,
    });

    const completeNotifs = fake
      .rows('fs_group_notifications')
      .filter((n) => n.data.type === 'task-complete');
    expect(completeNotifs).toHaveLength(1);
    expect(completeNotifs[0].parent_path).toBe('users/u-1/notifications');
    expect(completeNotifs[0].data).toMatchObject({
      userId: 'u-1',
      taskId: 'task-1',
      points: 30,
      hoursWorked: 2,
      badgeId: 'badge-1',
      read: false,
      priority: 'P2',
      link: '/tasks/task-1',
    });

    const task = fake.rows('fs_tasks')[0].data;
    expect(task.rewardApplied).toBe(true);
    expect(typeof task.completedAt).toBe('string');

    // Post-transaction activity add still lands in the subcollection.
    expect(fake.rows('fs_group_activity').filter((a) => a.data.type === 'taskUpdated')).toHaveLength(1);

    // Second delivery of the same completion event: the transaction's
    // rewardApplied guard (inside the callback, as written) makes the
    // reward a no-op — no further points, ledger rows or notifications.
    const res2: any = await POST(whRequest(body));
    expect(res2.status).toBe(200);
    expect(fake.rows('fs_users')[0].data.points).toBe(40);
    expect(fake.rows('fs_users')[0].data.tasksCompletedCount).toBe(3);
    expect(fake.rows('fs_group_rewards')).toHaveLength(1);
    expect(
      fake.rows('fs_group_notifications').filter((n) => n.data.type === 'task-complete'),
    ).toHaveLength(1);
  });

  it('(c) roles event → claims sync on the REAL Auth API, with NO users-doc write', async () => {
    const seedData = { chapterId: 'ch-1', displayName: 'User One' };
    fake.seed('fs_users', [landingRow('u-1', { ...seedData }, 'users', 'u-1')]);
    const res: any = await POST(
      whRequest({ collection: 'roles', docId: 'u-1', eventType: 'create', before: null, after: { role: 'chapter_lead' } }),
    );
    expect(res.status).toBe(200);
    // Auth is not data (C-G5-2): the claims call hit the Auth mock,
    // not any fs_* table.
    expect(mockState.claims).toEqual([
      { uid: 'u-1', claims: { role: 'chapter_lead', chapter_id: 'ch-1' } },
    ]);
    const users = fake.rows('fs_users');
    expect(users).toHaveLength(1);
    expect(users[0].data).toEqual(seedData);
    expect(mockState.firestoreCalls).toHaveLength(0);
  });

  it('(d) positions becoming current → continuity batch ends the other current positions for the role', async () => {
    fake.seed('fs_positions', [
      landingRow('pos-old', { role: 'chair', endDate: null }, 'positions'),
      landingRow('pos-1', { role: 'chair', endDate: null }, 'positions'),
      landingRow('pos-other', { role: 'secretary', endDate: null }, 'positions'),
    ]);
    const res: any = await POST(
      whRequest({
        collection: 'positions',
        docId: 'pos-1',
        eventType: 'create',
        before: null,
        after: { role: 'chair', userId: 'u-9', startDate: '2026-01-01', endDate: null },
      }),
    );
    expect(res.status).toBe(200);
    const byId = new Map(fake.rows('fs_positions').map((r) => [r.id, r.data]));
    expect(byId.get('pos-old')).toMatchObject({
      role: 'chair',
      endDate: '2026-01-01',
      continuityUpdated: true,
      updatedBy: 'system',
    });
    expect(typeof byId.get('pos-old')?.updatedAt).toBe('string');
    expect(byId.get('pos-1')).toEqual({ role: 'chair', endDate: null });
    expect(byId.get('pos-other')).toEqual({ role: 'secretary', endDate: null });
  });

  it('(d) deleting a CURRENT position → audit_logs add lands in fs_audit_logs', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'positions',
        docId: 'pos-1',
        eventType: 'delete',
        before: { role: 'chair', userId: 'u-9', startDate: '2025-06-01' },
        after: null,
      }),
    );
    expect(res.status).toBe(200);
    const audit = fake.rows('fs_audit_logs');
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({
      type: 'position_deletion',
      action: 'current_position_deleted',
      positionId: 'pos-1',
      role: 'chair',
      userId: 'u-9',
      startDate: '2025-06-01',
      systemGenerated: true,
      warning: 'A current position was deleted - manual review recommended',
    });
    expect(typeof audit[0].data.deletedAt).toBe('string');
  });
});

describe('flag OFF — handlers receive the Firestore db (behaviour untouched)', () => {
  it('(e) tasks create runs entirely on the Firestore db; the fs_* tables stay empty', async () => {
    mockState.supaHandle = null; // supaDbHandleFor returns null: flag OFF / no client
    const res: any = await POST(
      whRequest({
        collection: 'tasks',
        docId: 'task-1',
        eventType: 'create',
        before: null,
        after: { title: 'Build Rover', createdBy: 'creator-1', assigneeIds: ['u-1', 'u-2'], status: 'pending' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockState.surfaces).toEqual(['webhooks']);

    const activity = mockState.firestoreCalls.filter(
      (c) => c.op === 'add' && c.path === 'users/creator-1/activity',
    );
    expect(activity).toHaveLength(1);
    expect(activity[0].data).toMatchObject({ type: 'taskCreated', taskId: 'task-1' });
    const notifs = mockState.firestoreCalls.filter(
      (c) => c.op === 'batch-set' && c.path.includes('/notifications/'),
    );
    expect(notifs.map((n) => n.path.split('/')[1]).sort()).toEqual(['u-1', 'u-2']);
    expect(mockState.firestoreCalls.filter((c) => c.op === 'batch-commit')).toHaveLength(1);
    expect(
      mockState.firestoreCalls.filter((c) => c.op === 'set' && c.path === 'universal_submissions/tasks_task-1'),
    ).toHaveLength(1);

    for (const table of [
      'fs_tasks',
      'fs_users',
      'fs_group_activity',
      'fs_group_notifications',
      'fs_universal_submissions',
    ]) {
      expect(fake.rows(table)).toHaveLength(0);
    }
  });
});
