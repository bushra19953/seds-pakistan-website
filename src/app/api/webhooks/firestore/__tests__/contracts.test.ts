/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for POST /api/webhooks/firestore —
 * companion to src/app/api/webhooks/dispatch/__tests__/fresh-signup.test.ts
 * (which pins the signup 500 regression, the secret/validation arms and
 * the email-lowercase sync). This file pins the WRITE SET of every
 * handler branch the migration must reproduce through the adapter:
 *
 *  - tasks create / update-completion (transaction) / delete
 *  - users update: badge awards + leaderboard cache invalidation
 *  - roles: custom-claims sync only (the users-doc mirror write is
 *    retired — pinned by asserting NO users update happens)
 *  - positions: continuity batch + deletion audit record
 *  - leave_requests / applications / form_responses / submissions:
 *    universal_submissions sync rows and their type mappings
 *  - users/{uid}/notifications create: FCM multicast payload
 *  - the 503 db-down body and the unknown-collection no-op
 *
 * Firestore is a fake in-memory boundary; zero live reads. No real
 * credential values appear anywhere in this file.
 */

// Mutable per-test fake-Firestore state. The `mock` prefix is required
// for variables referenced inside jest.mock factories.
const mockState = {
  dbAvailable: true,
  userDocs: new Map<string, any>(),
  badges: [] as any[],
  positions: [] as Array<{ id: string; data: any }>,
  txTask: null as any,
  calls: [] as Array<{ op: string; path: string; data?: any; opts?: any }>,
  claims: [] as Array<{ uid: string; claims: any }>,
  customClaimsByUid: new Map<string, any>(),
  messages: [] as any[],
};

function mockDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const seg = path.split('/');
      if (seg[0] === 'users' && seg.length === 2) {
        const data = mockState.userDocs.get(seg[1]);
        return { exists: data !== undefined, data: () => data };
      }
      if (seg[0] === 'tasks' && seg.length === 2) {
        return { exists: mockState.txTask != null, data: () => mockState.txTask };
      }
      return { exists: true, data: () => ({}) };
    },
    update: async (data: any) => {
      mockState.calls.push({ op: 'update', path, data });
    },
    set: async (data: any, opts?: any) => {
      mockState.calls.push({ op: 'set', path, data, opts });
    },
    delete: async () => {
      mockState.calls.push({ op: 'delete', path });
    },
    collection: (sub: string) => ({
      add: async (data: any) => {
        mockState.calls.push({ op: 'add', path: `${path}/${sub}`, data });
        return { id: 'generated-sub-id' };
      },
      doc: (subId?: string) => mockDocRef(`${path}/${sub}/${subId ?? 'auto-id'}`),
    }),
  };
}

function mockQuery(rows: Array<{ id: string; data: any }>, collectionName: string, filters: Array<[string, any]> = []): any {
  return {
    where: (field: string, _op: string, value: any) => mockQuery(rows, collectionName, [...filters, [field, value]]),
    get: async () => {
      const matched = rows.filter((r) => filters.every(([f, v]) => r.data[f] === v));
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => r.data, ref: mockDocRef(`${collectionName}/${r.id}`) })),
      };
    },
  };
}

const mockDb = {
  collection: (name: string) => ({
    doc: (id?: string) => mockDocRef(`${name}/${id ?? 'auto-id'}`),
    add: async (data: any) => {
      mockState.calls.push({ op: 'add', path: name, data });
      return { id: 'generated-id' };
    },
    get: async () => {
      if (name === 'badges') return { docs: mockState.badges.map((d) => ({ data: () => d })) };
      return { docs: [] };
    },
    where: (field: string, op: string, value: any) => {
      if (name === 'positions') return mockQuery(mockState.positions, name).where(field, op, value);
      return { get: async () => ({ docs: [] }) };
    },
  }),
  batch: () => ({
    set: (ref: any, data: any, opts?: any) => mockState.calls.push({ op: 'batch-set', path: ref.path, data, opts }),
    update: (ref: any, data: any) => mockState.calls.push({ op: 'batch-update', path: ref.path, data }),
    delete: (ref: any) => mockState.calls.push({ op: 'batch-delete', path: ref.path }),
    commit: async () => {
      mockState.calls.push({ op: 'batch-commit', path: '' });
    },
  }),
  runTransaction: async (fn: any) =>
    fn({
      get: async (ref: any) => {
        const seg = ref.path.split('/');
        if (seg[0] === 'tasks') return { data: () => mockState.txTask };
        const data = mockState.userDocs.get(seg[1]);
        return { data: () => data };
      },
      update: (ref: any, data: any) => mockState.calls.push({ op: 'tx-update', path: ref.path, data }),
      set: (ref: any, data: any, opts?: any) => mockState.calls.push({ op: 'tx-set', path: ref.path, data, opts }),
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
  getDb: () => (mockState.dbAvailable ? mockDb : null),
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: mockState.customClaimsByUid.get(uid) ?? {} }),
    setCustomUserClaims: async (uid: string, claims: any) => {
      mockState.claims.push({ uid, claims });
    },
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    increment: (n: number) => ({ __fv: 'increment', n }),
    arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
  },
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

const SECRET = 'test-webhook-secret';

function whRequest(body: any): any {
  return new Request('http://localhost/api/webhooks/firestore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify(body),
  });
}

function callsOn(op: string, path: string) {
  return mockState.calls.filter((c) => c.op === op && c.path === path);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.dbAvailable = true;
  mockState.userDocs = new Map();
  mockState.badges = [];
  mockState.positions = [];
  mockState.txTask = null;
  mockState.calls = [];
  mockState.claims = [];
  mockState.customClaimsByUid = new Map();
  mockState.messages = [];
  process.env.FIRESTORE_WEBHOOK_SECRET = SECRET;
});

describe('POST /api/webhooks/firestore — routing-level contract', () => {
  it('db unavailable -> 503 { success: false, error: "Database unavailable" }', async () => {
    mockState.dbAvailable = false;
    const res: any = await POST(whRequest({ collection: 'users', docId: 'u-1', eventType: 'create', before: null, after: {} }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: 'Database unavailable' });
  });

  it('unknown collection -> 200 { success: true } with zero writes', async () => {
    const res: any = await POST(whRequest({ collection: 'widgets', docId: 'w-1', eventType: 'create', before: null, after: { a: 1 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockState.calls).toHaveLength(0);
    expect(mockState.claims).toHaveLength(0);
  });
});

describe('tasks handler — write set', () => {
  it('create: creator activity add, per-assignee notification batch-set, universal sync row', async () => {
    mockState.userDocs.set('u-1', { displayName: 'User One', photoURL: 'pic-1', chapterId: 'ch-1' });
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

    const activity = callsOn('add', 'users/creator-1/activity');
    expect(activity).toHaveLength(1);
    expect(activity[0].data).toMatchObject({ type: 'taskCreated', taskId: 'task-1', taskTitle: 'Build Rover' });
    expect(activity[0].data.createdAt).toBeInstanceOf(Date);

    const notifs = mockState.calls.filter((c) => c.op === 'batch-set' && c.path.includes('/notifications/'));
    expect(notifs.map((n) => n.path.split('/')[1]).sort()).toEqual(['u-1', 'u-2']);
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
      expect(n.data.userId).toBe(n.path.split('/')[1]);
    }
    expect(mockState.calls.filter((c) => c.op === 'batch-commit')).toHaveLength(1);

    const sync = callsOn('set', 'universal_submissions/tasks_task-1');
    expect(sync).toHaveLength(1);
    expect(sync[0].opts).toEqual({ merge: true });
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
  });

  it('delete: per-assignee taskDeleted activity adds and the universal sync row is deleted', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'tasks',
        docId: 'task-9',
        eventType: 'delete',
        before: { title: 'Old Task', assigneeIds: ['u-1', 'u-2'] },
        after: null,
      }),
    );
    expect(res.status).toBe(200);
    for (const uid of ['u-1', 'u-2']) {
      const adds = callsOn('add', `users/${uid}/activity`);
      expect(adds).toHaveLength(1);
      expect(adds[0].data).toMatchObject({ type: 'taskDeleted', taskId: 'task-9', taskTitle: 'Old Task' });
    }
    expect(callsOn('delete', 'universal_submissions/tasks_task-9')).toHaveLength(1);
  });

  it('update to completed: the reward transaction writes user increments, badge union, rewards ledger and notification, then stamps the task', async () => {
    mockState.txTask = {
      title: 'Tx Task',
      points: 30,
      hoursWorked: 2,
      completionBadgeId: 'badge-1',
      assigneeIds: ['u-1'],
      deadline: { toDate: () => new Date(Date.now() + 86400000) },
    };
    const res: any = await POST(
      whRequest({
        collection: 'tasks',
        docId: 'task-1',
        eventType: 'update',
        before: { status: 'in-progress' },
        after: { status: 'completed', title: 'Tx Task', assigneeIds: ['u-1'] },
      }),
    );
    expect(res.status).toBe(200);

    const userUpdates = callsOn('tx-update', 'users/u-1');
    expect(userUpdates[0].data).toEqual({
      points: { __fv: 'increment', n: 30 },
      totalHoursWorked: { __fv: 'increment', n: 2 },
      tasksCompletedCount: { __fv: 'increment', n: 1 },
      tasksCompletedOnTimeCount: { __fv: 'increment', n: 1 },
      lastTaskCompletedAt: expect.any(Date),
    });
    expect(userUpdates[1].data).toEqual({ badges: { __fv: 'arrayUnion', vals: ['badge-1'] } });

    const ledger = callsOn('tx-set', 'users/u-1/rewards/task-1');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].opts).toEqual({ merge: true });
    expect(ledger[0].data).toMatchObject({ taskId: 'task-1', pointsAwarded: 30, hoursAwarded: 2, badgeId: 'badge-1', onTime: true });

    const notif = mockState.calls.find((c) => c.op === 'tx-set' && c.path.startsWith('users/u-1/notifications/'));
    expect(notif?.data).toMatchObject({ userId: 'u-1', type: 'task-complete', taskId: 'task-1', points: 30, hoursWorked: 2, badgeId: 'badge-1', read: false, priority: 'P2', link: '/tasks/task-1' });

    const taskStamp = callsOn('tx-update', 'tasks/task-1');
    expect(taskStamp).toHaveLength(1);
    expect(taskStamp[0].data).toMatchObject({ rewardApplied: true });
    expect(taskStamp[0].data.completedAt).toBeInstanceOf(Date);

    // Post-transaction: an activity add per assignee + the universal sync.
    const act = callsOn('add', 'users/u-1/activity');
    expect(act).toHaveLength(1);
    expect(act[0].data).toMatchObject({ type: 'taskUpdated', taskId: 'task-1' });
    expect(callsOn('set', 'universal_submissions/tasks_task-1')[0].data).toMatchObject({ type: 'TASK_REVIEW', status: 'COMPLETED' });
  });

  it('update to completed with rewardApplied already set: transaction is a no-op for users, activity + sync still happen', async () => {
    mockState.txTask = { title: 'Tx Task', points: 30, assigneeIds: ['u-1'], rewardApplied: true };
    const res: any = await POST(
      whRequest({
        collection: 'tasks',
        docId: 'task-1',
        eventType: 'update',
        before: { status: 'in-progress' },
        after: { status: 'completed', title: 'Tx Task', assigneeIds: ['u-1'] },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockState.calls.filter((c) => c.op.startsWith('tx-'))).toHaveLength(0);
    expect(callsOn('add', 'users/u-1/activity')).toHaveLength(1);
  });
});

describe('users handler — write set', () => {
  it('points increase awards newly-earned badge slugs via arrayUnion (owned and too-expensive badges excluded)', async () => {
    mockState.badges = [
      { slug: 'starter', pointsRequired: 50, isActive: true },
      { slug: 'pro', pointsRequired: 80, isActive: true },
      { slug: 'elite', pointsRequired: 500, isActive: true },
      { slug: 'retired', pointsRequired: 10, isActive: false },
    ];
    const res: any = await POST(
      whRequest({
        collection: 'users',
        docId: 'u-1',
        eventType: 'update',
        before: { points: 10, email_lowercase: 'a@b.c' },
        after: { points: 100, badges: ['starter'], email_lowercase: 'a@b.c' },
      }),
    );
    expect(res.status).toBe(200);
    const updates = callsOn('update', 'users/u-1');
    expect(updates).toHaveLength(1);
    expect(updates[0].data.badges).toEqual({ __fv: 'arrayUnion', vals: ['pro'] });
    expect(updates[0].data.updatedAt).toBeInstanceOf(Date);
  });

  it('relevant-field change invalidates the leaderboard cache with the exact set payload', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'users',
        docId: 'u-1',
        eventType: 'update',
        before: { points: 5, displayName: 'Old Name', email_lowercase: 'a@b.c' },
        after: { points: 5, displayName: 'New Name', email_lowercase: 'a@b.c' },
      }),
    );
    expect(res.status).toBe(200);
    const cache = callsOn('set', 'cache/leaderboard');
    expect(cache).toHaveLength(1);
    expect(cache[0].opts).toEqual({ merge: true });
    expect(cache[0].data.invalidatedUser).toBe('u-1');
    expect(cache[0].data.lastUpdated).toBeInstanceOf(Date);
  });

  it('chapter change syncs the chapter_id custom claim, preserving existing claims', async () => {
    mockState.customClaimsByUid.set('u-1', { role: 'member', other: 1 });
    const res: any = await POST(
      whRequest({
        collection: 'users',
        docId: 'u-1',
        eventType: 'update',
        before: { points: 5, chapterId: 'ch-1', email_lowercase: 'a@b.c' },
        after: { points: 5, chapterId: 'ch-2', email_lowercase: 'a@b.c' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockState.claims).toEqual([
      { uid: 'u-1', claims: { role: 'member', other: 1, chapter_id: 'ch-2' } },
    ]);
  });
});

describe('roles handler — claims-only contract', () => {
  it('create: sets custom claims { role, chapter_id } and writes NOTHING to the users doc (mirror write is retired)', async () => {
    mockState.userDocs.set('u-1', { chapterId: 'ch-1' });
    const res: any = await POST(
      whRequest({ collection: 'roles', docId: 'u-1', eventType: 'create', before: null, after: { role: 'chapter_lead' } }),
    );
    expect(res.status).toBe(200);
    expect(mockState.claims).toEqual([{ uid: 'u-1', claims: { role: 'chapter_lead', chapter_id: 'ch-1' } }]);
    expect(mockState.calls.filter((c) => c.path === 'users/u-1')).toHaveLength(0);
  });

  it('delete: claims are re-set WITHOUT a role key (chapter only)', async () => {
    mockState.userDocs.set('u-1', { chapterId: 'ch-1' });
    const res: any = await POST(
      whRequest({ collection: 'roles', docId: 'u-1', eventType: 'delete', before: { role: 'chapter_lead' }, after: null }),
    );
    expect(res.status).toBe(200);
    expect(mockState.claims).toEqual([{ uid: 'u-1', claims: { chapter_id: 'ch-1' } }]);
  });

  it('non-string role in the payload is dropped from claims (type guard)', async () => {
    mockState.userDocs.set('u-1', { chapterId: 'ch-1' });
    const res: any = await POST(
      whRequest({ collection: 'roles', docId: 'u-1', eventType: 'create', before: null, after: { role: 42 } }),
    );
    expect(res.status).toBe(200);
    expect(mockState.claims).toEqual([{ uid: 'u-1', claims: { chapter_id: 'ch-1' } }]);
  });
});

describe('positions handler — write set', () => {
  it('a position becoming current ends the OTHER current positions for the role in one batch', async () => {
    mockState.positions = [
      { id: 'pos-old', data: { role: 'chair', endDate: null } },
      { id: 'pos-1', data: { role: 'chair', endDate: null } },
      { id: 'pos-other-role', data: { role: 'secretary', endDate: null } },
    ];
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
    const updates = mockState.calls.filter((c) => c.op === 'batch-update');
    expect(updates).toHaveLength(1);
    expect(updates[0].path).toBe('positions/pos-old');
    expect(updates[0].data).toMatchObject({ endDate: '2026-01-01', continuityUpdated: true, updatedBy: 'system' });
    expect(updates[0].data.updatedAt).toBeInstanceOf(Date);
    expect(mockState.calls.filter((c) => c.op === 'batch-commit')).toHaveLength(1);
  });

  it('deleting a CURRENT position (no endDate) writes the exact audit_logs record', async () => {
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
    const adds = callsOn('add', 'audit_logs');
    expect(adds).toHaveLength(1);
    expect(adds[0].data).toMatchObject({
      type: 'position_deletion',
      action: 'current_position_deleted',
      positionId: 'pos-1',
      role: 'chair',
      userId: 'u-9',
      startDate: '2025-06-01',
      systemGenerated: true,
      warning: 'A current position was deleted - manual review recommended',
    });
    expect(adds[0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('deleting an already-ended position writes NO audit record', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'positions',
        docId: 'pos-1',
        eventType: 'delete',
        before: { role: 'chair', userId: 'u-9', startDate: '2025-06-01', endDate: '2025-12-01' },
        after: null,
      }),
    );
    expect(res.status).toBe(200);
    expect(callsOn('add', 'audit_logs')).toHaveLength(0);
  });
});

describe('submissions sync — universal_submissions mappings', () => {
  it('leave_requests create -> type LEAVE_REQUEST with the date-range summary', async () => {
    mockState.userDocs.set('u-1', { displayName: 'User One', photoURL: 'pic-1', chapterId: 'ch-1' });
    const res: any = await POST(
      whRequest({
        collection: 'leave_requests',
        docId: 'lr-1',
        eventType: 'create',
        before: null,
        after: { userId: 'u-1', startDate: '2026-02-01', endDate: '2026-02-03', status: 'pending' },
      }),
    );
    expect(res.status).toBe(200);
    const sync = callsOn('set', 'universal_submissions/leave_requests_lr-1');
    expect(sync).toHaveLength(1);
    expect(sync[0].data).toMatchObject({
      global_id: 'leave_requests_lr-1',
      original_ref: 'leave_requests/lr-1',
      type: 'LEAVE_REQUEST',
      status: 'PENDING',
      summary_text: 'Leave Request: 2026-02-01 to 2026-02-03',
      user_id: 'u-1',
    });
  });

  it('applications create -> type APPLICATION with the role summary', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'applications',
        docId: 'app-1',
        eventType: 'create',
        before: null,
        after: { userId: 'u-2', roleAppliedFor: 'Rocketry Lead', status: 'submitted', chapterId: 'ch-9', userDisplayName: 'Applicant Two', userPhotoURL: 'pic-2' },
      }),
    );
    expect(res.status).toBe(200);
    const sync = callsOn('set', 'universal_submissions/applications_app-1');
    expect(sync[0].data).toMatchObject({
      type: 'APPLICATION',
      status: 'SUBMITTED',
      summary_text: 'Application: Rocketry Lead',
      chapter_id: 'ch-9',
      user_display_name: 'Applicant Two',
    });
  });

  it('form_responses create -> type FORM_RESPONSE', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'form_responses',
        docId: 'fr-1',
        eventType: 'create',
        before: null,
        after: { userId: 'u-3', formTitle: 'Intake 2026', chapterId: 'ch-1', userDisplayName: 'Three', userPhotoURL: 'p3' },
      }),
    );
    expect(res.status).toBe(200);
    const sync = callsOn('set', 'universal_submissions/form_responses_fr-1');
    expect(sync[0].data).toMatchObject({ type: 'FORM_RESPONSE', summary_text: 'Form Response: Intake 2026', status: 'PENDING' });
  });

  it('submissions create -> type SUBMISSION (the mapping default) with "<TYPE>: <title>" summary', async () => {
    const res: any = await POST(
      whRequest({
        collection: 'submissions',
        docId: 'sub-1',
        eventType: 'create',
        before: null,
        after: { userId: 'u-4', type: 'resource', title: 'Field Guide', chapterId: 'ch-1', userDisplayName: 'Four', userPhotoURL: 'p4' },
      }),
    );
    expect(res.status).toBe(200);
    const sync = callsOn('set', 'universal_submissions/submissions_sub-1');
    expect(sync[0].data).toMatchObject({ type: 'SUBMISSION', summary_text: 'RESOURCE: Field Guide' });
  });

  it('any synced collection delete -> the universal_submissions row is deleted, nothing else written', async () => {
    const res: any = await POST(
      whRequest({ collection: 'applications', docId: 'app-1', eventType: 'delete', before: { status: 'submitted' }, after: null }),
    );
    expect(res.status).toBe(200);
    expect(mockState.calls).toEqual([{ op: 'delete', path: 'universal_submissions/applications_app-1' }]);
  });
});

describe('notification push handler — FCM contract', () => {
  // The handler is reached only when the collection string contains
  // '/notifications/' (with BOTH slashes). A full nested path such as
  // 'users/<uid>/notifications/<segment>' satisfies the check.
  const notifBody = (after: any) => ({
    collection: 'users/u-1/notifications/thread',
    docId: 'notif-1',
    eventType: 'create',
    before: null,
    after,
  });

  // Current-behaviour pin (latent dead path): the real client wrapper
  // (src/lib/client/firestore-wrapper.ts, isWebhookCollection) sends
  // collection 'users/notifications' for notification writes — which
  // does NOT contain '/notifications/', so the push handler is never
  // reached from the current client and the event is a silent no-op.
  it('the collection string the current client wrapper sends ("users/notifications") never reaches the push handler', async () => {
    mockState.userDocs.set('u-1', { fcmTokens: ['tok-a'], pushEnabled: true });
    const res: any = await POST(
      whRequest({
        collection: 'users/notifications',
        docId: 'notif-1',
        eventType: 'create',
        before: null,
        after: { userId: 'u-1', title: 'Hello', body: 'World', priority: 'P1' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockState.messages).toHaveLength(0);
  });

  it('create with tokens + push enabled sends the exact multicast payload', async () => {
    mockState.userDocs.set('u-1', { fcmTokens: ['tok-a', 'tok-b'], pushEnabled: true });
    const res: any = await POST(whRequest(notifBody({ userId: 'u-1', title: 'Hello', body: 'World', priority: 'P1', link: '/inbox' })));
    expect(res.status).toBe(200);
    expect(mockState.messages).toEqual([
      {
        tokens: ['tok-a', 'tok-b'],
        notification: { title: 'Hello', body: 'World' },
        data: { link: '/inbox', clickAction: 'FLUTTER_NOTIFICATION_CLICK' },
        webpush: { fcmOptions: { link: '/inbox' } },
      },
    ]);
  });

  it('P3 priority never sends', async () => {
    mockState.userDocs.set('u-1', { fcmTokens: ['tok-a'], pushEnabled: true });
    await POST(whRequest(notifBody({ userId: 'u-1', title: 'Quiet', priority: 'P3' })));
    expect(mockState.messages).toHaveLength(0);
  });

  it('pushEnabled false never sends; missing user never sends', async () => {
    mockState.userDocs.set('u-1', { fcmTokens: ['tok-a'], pushEnabled: false });
    await POST(whRequest(notifBody({ userId: 'u-1', title: 'Hi', priority: 'P1' })));
    await POST(whRequest(notifBody({ userId: 'ghost', title: 'Hi', priority: 'P1' })));
    expect(mockState.messages).toHaveLength(0);
  });

  it('non-create events never send', async () => {
    mockState.userDocs.set('u-1', { fcmTokens: ['tok-a'], pushEnabled: true });
    await POST(whRequest({ ...notifBody({ userId: 'u-1', title: 'Hi', priority: 'P1' }), eventType: 'update' }));
    expect(mockState.messages).toHaveLength(0);
  });
});
