/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/remind-deadlines —
 * companion to the existing route.test.ts in this folder (which pins
 * the B3 bearer arms with empty snapshots). This file pins the write
 * SET of both passes and the manual-arm weakness:
 *
 *  - TS-P25: the manual arm accepts ANY authenticated caller who has a
 *    role — no permission check exists in this route. Pinned as
 *    current behaviour, NOT fixed.
 *  - Pass 1 (24h reminders): notification payload per assignee, and
 *    the task-doc update set on success ({ reminderSent24h,
 *    reminder24hSentAt, reminder24hError/-At deleted }) vs on send
 *    failure ({ reminder24hError, reminder24hErrorAt } only — the sent
 *    flag is withheld).
 *  - Pass 2 (acceptance nudges): same shape with the
 *    acceptanceNudge* fields, the 24h grace rule, and the
 *    already-nudged skip.
 *
 * Firestore is a fake in-memory boundary; zero live reads.
 */

import { NextRequest } from 'next/server';

type FakeDoc = {
  id: string;
  data: () => Record<string, any>;
  ref: { update: jest.Mock };
};

const state = {
  authResult: { authenticated: false } as any,
  adminInit: true,
  dbAvailable: true,
  dueSoonDocs: [] as FakeDoc[],
  acceptanceDocs: [] as FakeDoc[],
  sendCalls: [] as Array<{ uid: string; payload: any; priority: string }>,
  sendFailures: new Set<string>(),
  queryError: null as any,
};

function makeDoc(id: string, data: Record<string, any>): FakeDoc {
  return { id, data: () => data, ref: { update: jest.fn(async () => undefined) } };
}

const mockDb = {
  collection: (name: string) => {
    if (name !== 'tasks') throw new Error(`unexpected collection: ${name}`);
    const query: any = {
      _isAcceptance: false,
      where: (field: string) => {
        if (field === 'acceptanceStatus') query._isAcceptance = true;
        return query;
      },
      get: async () => {
        if (state.queryError) throw state.queryError;
        const docs = query._isAcceptance ? state.acceptanceDocs : state.dueSoonDocs;
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
    return query;
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => (state.dbAvailable ? mockDb : null)),
  ensureAdminInitialized: jest.fn(() => state.adminInit),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (uid: string, payload: any, priority: string) => {
      state.sendCalls.push({ uid, payload, priority });
      if (state.sendFailures.has(uid)) throw new Error(`send failed for ${uid}`);
    }),
  },
}));

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
        delete: () => ({ __fv: 'fieldDelete' }),
      },
    },
  },
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';
const ST = { __fv: 'serverTimestamp' };
const DEL = { __fv: 'fieldDelete' };

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/remind-deadlines', { method, headers });
}

const cronHeaders = { Authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.adminInit = true;
  state.dbAvailable = true;
  state.dueSoonDocs = [];
  state.acceptanceDocs = [];
  state.sendCalls = [];
  state.sendFailures = new Set();
  state.queryError = null;
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/remind-deadlines — manual arm (TS-P25)', () => {
  // SECURITY FLAG TS-P25 (current behaviour, pinned not fixed): any
  // authenticated caller carrying SOME role triggers both passes.
  // This route never imports hasServerPermission; a plain member runs
  // the full reminder/nudge sweep and its task-doc writes.
  it('SECURITY FLAG TS-P25: any authenticated user with any role (plain member, no permission check) triggers both passes', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-member', role: 'member' } };
    state.dueSoonDocs = [
      makeDoc('t-1', { title: 'Fixture Task', assigneeIds: ['u-9'], deadline: { toDate: () => new Date(Date.now() + 24 * 3600 * 1000) } }),
    ];
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(200);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].uid).toBe('u-9');
  });

  it('authenticated caller WITHOUT a role gets 401 { error: "Unauthorized" }', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1' } };
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.sendCalls).toHaveLength(0);
  });

  it('admin not initialized -> 500 { error: "Firebase Admin not initialized" }', async () => {
    state.adminInit = false;
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firebase Admin not initialized' });
  });

  it('db unavailable -> 500 { error: "Firestore not initialized" }', async () => {
    state.dbAvailable = false;
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Firestore not initialized' });
  });

  it('task query failure -> 500 { error: <message> } from the outer catch', async () => {
    state.queryError = new Error('tasks index missing');
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'tasks index missing' });
  });
});

describe('/api/cron/remind-deadlines — pass 1 write set (24h reminders)', () => {
  it('sends one P1 deadline_reminder per assignee and stamps the exact success update set', async () => {
    const deadline = new Date(Date.now() + 24 * 3600 * 1000);
    const doc = makeDoc('t-1', {
      title: 'Rocket Report',
      assigneeIds: ['u-1', 'u-2'],
      deadline: { toDate: () => deadline },
    });
    state.dueSoonDocs = [doc];

    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      reminders: { sent: 1, skipped: 0, failed: 0 },
      acceptanceNudges: { sent: 0, skipped: 0 },
    });

    const label = deadline.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
    for (const uid of ['u-1', 'u-2']) {
      const call = state.sendCalls.find((c) => c.uid === uid);
      expect(call?.priority).toBe('P1');
      expect(call?.payload).toEqual({
        type: 'deadline_reminder',
        title: '24h Deadline Reminder',
        body: `The deadline for "Rocket Report" is ${label}. Please make sure your submission is ready.`,
        link: '/tasks/t-1',
        metadata: { taskId: 't-1' },
      });
    }
    expect(doc.ref.update).toHaveBeenCalledTimes(1);
    expect(doc.ref.update).toHaveBeenCalledWith({
      reminderSent24h: true,
      reminder24hSentAt: ST,
      reminder24hError: DEL,
      reminder24hErrorAt: DEL,
    });
  });

  it('legacy single-assignee field (assigneeId) is honoured when assigneeIds is absent', async () => {
    const doc = makeDoc('t-2', { title: 'Solo', assigneeId: 'u-solo', deadline: { toDate: () => new Date() } });
    state.dueSoonDocs = [doc];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).reminders).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(state.sendCalls.map((c) => c.uid)).toEqual(['u-solo']);
  });

  it('already-reminded tasks (boolean flag OR timestamp) are skipped with no send and no write', async () => {
    const a = makeDoc('t-a', { title: 'A', assigneeIds: ['u-1'], reminderSent24h: true });
    const b = makeDoc('t-b', { title: 'B', assigneeIds: ['u-1'], reminder24hSentAt: { toDate: () => new Date() } });
    state.dueSoonDocs = [a, b];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).reminders).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(state.sendCalls).toHaveLength(0);
    expect(a.ref.update).not.toHaveBeenCalled();
    expect(b.ref.update).not.toHaveBeenCalled();
  });

  it('a task with no assignees is skipped with no write', async () => {
    const doc = makeDoc('t-3', { title: 'Orphan', assigneeIds: [] });
    state.dueSoonDocs = [doc];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).reminders).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(doc.ref.update).not.toHaveBeenCalled();
  });

  it('send failure: sent flag is WITHHELD, only the error fields are stamped, task counts as failed', async () => {
    const doc = makeDoc('t-4', {
      title: 'Fragile',
      assigneeIds: ['u-ok', 'u-bad'],
      deadline: { toDate: () => new Date() },
    });
    state.dueSoonDocs = [doc];
    state.sendFailures.add('u-bad');
    const res = await GET(req(cronHeaders));
    expect((await res.json()).reminders).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(doc.ref.update).toHaveBeenCalledTimes(1);
    expect(doc.ref.update).toHaveBeenCalledWith({
      reminder24hError: 'u-bad: send failed for u-bad',
      reminder24hErrorAt: ST,
    });
  });
});

describe('/api/cron/remind-deadlines — pass 2 write set (acceptance nudges)', () => {
  const twoDaysAgo = () => ({ toDate: () => new Date(Date.now() - 2 * 24 * 3600 * 1000) });

  it('nudges each assignee once (P1 acceptance_nudge) and stamps the exact success update set', async () => {
    const doc = makeDoc('t-5', {
      title: 'Silent Task',
      assigneeIds: ['u-7'],
      acceptanceStatus: 'pending-acceptance',
      createdAt: twoDaysAgo(),
    });
    state.acceptanceDocs = [doc];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).acceptanceNudges).toEqual({ sent: 1, skipped: 0 });
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].priority).toBe('P1');
    expect(state.sendCalls[0].payload.type).toBe('acceptance_nudge');
    expect(state.sendCalls[0].payload.title).toBe('Task Acceptance Pending');
    expect(state.sendCalls[0].payload.link).toBe('/tasks/t-5');
    expect(state.sendCalls[0].payload.metadata).toEqual({ taskId: 't-5' });
    expect(state.sendCalls[0].payload.body).toContain('"Silent Task"');
    expect(doc.ref.update).toHaveBeenCalledWith({
      acceptanceNudgeSent: true,
      acceptanceNudgeSentAt: ST,
      acceptanceNudgeError: DEL,
      acceptanceNudgeErrorAt: DEL,
    });
  });

  it('tasks younger than the 24h grace period are left alone: no send, no write, NOT counted as skipped', async () => {
    const doc = makeDoc('t-6', {
      title: 'Fresh Task',
      assigneeIds: ['u-7'],
      acceptanceStatus: 'pending-acceptance',
      createdAt: { toDate: () => new Date() },
    });
    state.acceptanceDocs = [doc];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).acceptanceNudges).toEqual({ sent: 0, skipped: 0 });
    expect(state.sendCalls).toHaveLength(0);
    expect(doc.ref.update).not.toHaveBeenCalled();
  });

  it('already-nudged tasks are skipped', async () => {
    const doc = makeDoc('t-7', {
      title: 'Nudged',
      assigneeIds: ['u-7'],
      acceptanceStatus: 'pending-acceptance',
      acceptanceNudgeSent: true,
      createdAt: twoDaysAgo(),
    });
    state.acceptanceDocs = [doc];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).acceptanceNudges).toEqual({ sent: 0, skipped: 1 });
    expect(state.sendCalls).toHaveLength(0);
  });

  it('nudge send failure stamps only the error fields (no sent flag, and the task is not counted sent or skipped)', async () => {
    const doc = makeDoc('t-8', {
      title: 'Unreachable',
      assigneeIds: ['u-bad'],
      acceptanceStatus: 'pending-acceptance',
      createdAt: twoDaysAgo(),
    });
    state.acceptanceDocs = [doc];
    state.sendFailures.add('u-bad');
    const res = await GET(req(cronHeaders));
    expect((await res.json()).acceptanceNudges).toEqual({ sent: 0, skipped: 0 });
    expect(doc.ref.update).toHaveBeenCalledWith({
      acceptanceNudgeError: 'u-bad: send failed for u-bad',
      acceptanceNudgeErrorAt: ST,
    });
  });
});
