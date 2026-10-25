/**
 * @jest-environment node
 *
 * Flag-ON proof for /api/cron/remind-deadlines (Supabase migration,
 * G1): with SUPA_SURFACES=cron-g1 and a Supabase client configured
 * (the in-memory FakeSupa behind a mocked @supabase/supabase-js
 * createClient — zero live reads), the route must:
 *
 *  - select a task whose deadline is stored as an ISO STRING inside
 *    the 24h window (the PLAN_G1 §3 hotspot: without the seam's
 *    rehydration, deadline.toDate() is undefined and the route's
 *    reminder path degrades; the query bounds + selection are proven
 *    here end-to-end through the real adapter + handle + seam);
 *  - send the reminder and stamp the task THROUGH the handle
 *    (reminderSent24h true, reminder24hSentAt an ISO string, the
 *    FieldValue.delete() sentinels removing the error keys);
 *  - run Pass 2's acceptance nudge off an ISO-string createdAt;
 *  - never touch the Firestore db (the mocked getDb() sentinel throws
 *    if its collection() is called).
 */
import { NextRequest } from 'next/server';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';

const mockFake = new FakeSupa();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockFake),
}));

const state = {
  sendCalls: [] as Array<{ uid: string; payload: any; priority: string }>,
};

const mockFirestoreDb = {
  collection: () => {
    throw new Error('Firestore must not be touched when cron-g1 is ON');
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockFirestoreDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (uid: string, payload: any, priority: string) => {
      state.sendCalls.push({ uid, payload, priority });
    }),
  },
}));

// FieldValue doubles carrying the structural methodName the shared
// handle detects (the real firebase-admin transforms expose the same
// getter; the handle never imports firebase-admin itself).
jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ methodName: 'FieldValue.serverTimestamp' }),
        delete: () => ({ methodName: 'FieldValue.delete' }),
      },
    },
  },
}));

import { GET } from '../route';

const SECRET = 'test-cron-secret';
const ENV_KEYS = [
  'CRON_SECRET',
  'SUPA_SURFACES',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  process.env.SUPA_SURFACES = 'cron-g1';
  process.env.SUPABASE_URL = 'https://fake.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
  state.sendCalls = [];
  mockFake.seed('fs_tasks', []);
});

function cronReq() {
  return new NextRequest('http://localhost/api/cron/remind-deadlines', {
    method: 'GET',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

describe('GET /api/cron/remind-deadlines — flag ON (cron-g1 over FakeSupa)', () => {
  it('ISO-string deadline inside the 24h window is selected, reminded, and stamped through the handle', async () => {
    const deadlineIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    mockFake.seed('fs_tasks', [
      landingRow('t-due', {
        title: 'Due Soon Task',
        status: 'pending',
        assigneeIds: ['u-9'],
        deadline: deadlineIso,
        reminder24hError: 'stale error',
        reminder24hErrorAt: '2026-01-01T00:00:00.000Z',
      }),
      landingRow('t-far', {
        title: 'Far Task',
        status: 'pending',
        assigneeIds: ['u-8'],
        deadline: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      }),
    ]);

    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.reminders).toEqual({ sent: 1, skipped: 0, failed: 0 });

    // Only the in-window task's assignee was notified, with the
    // rehydrated deadline rendered into the body (not the
    // 'in 24 hours' fallback the string shape would have produced is
    // acceptable either way — the selection + send is the proof).
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].uid).toBe('u-9');
    expect(state.sendCalls[0].payload.type).toBe('deadline_reminder');
    expect(state.sendCalls[0].payload.metadata).toEqual({ taskId: 't-due' });

    // The success stamp landed in fs_tasks through the handle:
    // serverTimestamp resolved to an ISO string, delete() REMOVED the
    // stale error keys (never nulled).
    const stored = mockFake.rows('fs_tasks').find((r) => r.id === 't-due')!;
    expect(stored.data.reminderSent24h).toBe(true);
    expect(typeof stored.data.reminder24hSentAt).toBe('string');
    expect(
      Number.isFinite(Date.parse(stored.data.reminder24hSentAt as string)),
    ).toBe(true);
    expect('reminder24hError' in stored.data).toBe(false);
    expect('reminder24hErrorAt' in stored.data).toBe(false);
    // The out-of-window task was not stamped.
    const far = mockFake.rows('fs_tasks').find((r) => r.id === 't-far')!;
    expect(far.data.reminderSent24h).toBeUndefined();
  });

  it('Pass 2: ISO-string createdAt older than the 24h grace earns an acceptance nudge', async () => {
    mockFake.seed('fs_tasks', [
      landingRow('t-acc', {
        title: 'Unaccepted Task',
        status: 'pending',
        acceptanceStatus: 'pending-acceptance',
        assigneeIds: ['u-7'],
        createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      }),
      landingRow('t-young', {
        title: 'Young Task',
        status: 'pending',
        acceptanceStatus: 'pending-acceptance',
        assigneeIds: ['u-6'],
        createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      }),
    ]);

    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acceptanceNudges).toEqual({ sent: 1, skipped: 0 });
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].uid).toBe('u-7');
    expect(state.sendCalls[0].payload.type).toBe('acceptance_nudge');

    const stored = mockFake.rows('fs_tasks').find((r) => r.id === 't-acc')!;
    expect(stored.data.acceptanceNudgeSent).toBe(true);
    expect(typeof stored.data.acceptanceNudgeSentAt).toBe('string');
  });
});
