/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET /api/cron/process-dlq —
 * companion to the existing route.test.ts in this folder (which pins
 * ONLY the fail-closed auth arms). This file pins the retry engine's
 * observable write SET per outcome:
 *
 *  - PROCESSED: task_approval_failed replays payload.updatesToApply
 *    onto tasks/{id}, stamps completedAt, and — only when the points
 *    ledger has no entry for (user_id, task_id) — batch-sets the user
 *    points increment AND the points_ledger record.
 *  - ALREADY_PROCESSED_IDEMPOTENTLY when the task is already completed.
 *  - FAILED_PERMANENTLY: task gone, attempt cap already reached, or
 *    the final attempt failing (with parkedAt + reason).
 *  - RETRY_SCHEDULED: attempts+1, lastError, nextRetryAt =
 *    now + min(5min * 2^attemptsSoFar, 24h).
 *  - NEEDS_MANUAL_REVIEW: gamification_tx_failed,
 *    universal_review_approval_failed and unknown actions, with the
 *    exact reason strings.
 *  - The empty-DLQ and all-in-backoff response messages.
 *
 * Firestore is a fake in-memory boundary; zero live reads. Date.now is
 * frozen so backoff arithmetic is asserted exactly.
 */

import { NextRequest } from 'next/server';

const NOW = 1_700_000_000_000;
const ST = { __fv: 'serverTimestamp' };

const state = {
  dlqDocs: [] as Array<{ id: string; data: Record<string, any> }>,
  tasks: new Map<string, Record<string, any> | null>(),
  taskGetError: null as any,
  ledgerCounts: new Map<string, number>(),
  batchOps: [] as Array<{ op: string; path: string; data?: any; opts?: any }>,
  batchCommits: 0,
};

function docRef(path: string) {
  return { path, id: path.split('/').pop() };
}

function dlqSnapshot() {
  const docs = state.dlqDocs.map((d) => ({
    id: d.id,
    data: () => d.data,
    ref: docRef(`dlq_points_retry/${d.id}`),
  }));
  return { docs, size: docs.length, empty: docs.length === 0 };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'dlq_points_retry') {
      const q: any = {
        where: () => q,
        limit: () => q,
        get: async () => dlqSnapshot(),
      };
      return q;
    }
    if (name === 'tasks') {
      return {
        doc: (id: string) => ({
          ...docRef(`tasks/${id}`),
          get: async () => {
            if (state.taskGetError) throw state.taskGetError;
            const data = state.tasks.get(id);
            return { exists: data != null, data: () => data ?? undefined };
          },
        }),
      };
    }
    if (name === 'users') {
      return { doc: (id: string) => docRef(`users/${id}`) };
    }
    if (name === 'points_ledger') {
      let uid = '';
      let taskId = '';
      const q: any = {
        where: (field: string, _op: string, v: string) => {
          if (field === 'user_id') uid = v;
          if (field === 'task_id') taskId = v;
          return q;
        },
        count: () => ({
          get: async () => ({ data: () => ({ count: state.ledgerCounts.get(`${uid}|${taskId}`) ?? 0 }) }),
        }),
      };
      return {
        ...q,
        doc: () => docRef(`points_ledger/auto-${state.batchOps.length}`),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    update: (ref: any, data: any) => state.batchOps.push({ op: 'update', path: ref.path, data }),
    set: (ref: any, data: any, opts?: any) => state.batchOps.push({ op: 'set', path: ref.path, data, opts }),
    commit: async () => {
      state.batchCommits += 1;
    },
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
        increment: (n: number) => ({ __fv: 'increment', n }),
      },
      Timestamp: {
        fromMillis: (ms: number) => ({ __ts: ms, toMillis: () => ms }),
        now: () => ({ __ts: 'now' }),
      },
    },
  },
}));

import { GET } from '../route';

const SECRET = 'test-cron-secret';

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/process-dlq', { method: 'GET', headers });
}

const cronHeaders = { authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  process.env.CRON_SECRET = SECRET;
  state.dlqDocs = [];
  state.tasks = new Map();
  state.taskGetError = null;
  state.ledgerCounts = new Map();
  state.batchOps = [];
  state.batchCommits = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

function opsOn(path: string) {
  return state.batchOps.filter((o) => o.path === path);
}

describe('/api/cron/process-dlq — migration contract', () => {
  it('empty DLQ -> 200 { message: "DLQ is empty. No operations to retry." } and no batch commit', async () => {
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'DLQ is empty. No operations to retry.' });
    expect(state.batchCommits).toBe(0);
  });

  it('all pending jobs in backoff -> 200 with the backoff message and pending count, no writes', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', attempts: 1, nextRetryAt: { toMillis: () => NOW + 60000 } } },
    ];
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      message: 'DLQ has pending jobs but all are in backoff. Nothing due.',
      pending: 1,
    });
    expect(state.batchOps).toHaveLength(0);
  });

  it('PROCESSED: completion replay writes task updates, completedAt, user points increment, ledger record, and the DLQ stamp', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 0, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    state.tasks.set('task-1', { status: 'in-progress', assigneeIds: ['u-1'], points: 50 });

    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      due: 1,
      outcomes: { PROCESSED: 1 },
      results: [{ id: 'd-1', action: 'task_approval_failed', attempt: 1, status: 'PROCESSED' }],
    });

    expect(opsOn('tasks/task-1')).toEqual([
      { op: 'update', path: 'tasks/task-1', data: { status: 'completed' } },
      { op: 'update', path: 'tasks/task-1', data: { completedAt: { __ts: 'now' } } },
    ]);
    const userSet = opsOn('users/u-1');
    expect(userSet).toHaveLength(1);
    expect(userSet[0].op).toBe('set');
    expect(userSet[0].opts).toEqual({ merge: true });
    expect(userSet[0].data).toEqual({
      total_points: { __fv: 'increment', n: 50 },
      points: { __fv: 'increment', n: 50 },
      tasksCompletedCount: { __fv: 'increment', n: 1 },
    });
    const ledgerSet = state.batchOps.find((o) => o.path.startsWith('points_ledger/'));
    expect(ledgerSet?.op).toBe('set');
    expect(ledgerSet?.data).toEqual({
      user_id: 'u-1',
      task_id: 'task-1',
      points_awarded: 50,
      timestamp: ST,
      status: 'PROCESSED',
    });
    expect(opsOn('dlq_points_retry/d-1')).toEqual([
      { op: 'update', path: 'dlq_points_retry/d-1', data: { status: 'PROCESSED', attempts: 1, processedAt: ST } },
    ]);
    expect(state.batchCommits).toBe(1);
  });

  it('ledger guard: an existing points_ledger entry suppresses the user + ledger writes; the job still lands PROCESSED', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 2, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    state.tasks.set('task-1', { status: 'in-progress', assigneeIds: ['u-1'], points: 50 });
    state.ledgerCounts.set('u-1|task-1', 1);

    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ PROCESSED: 1 });
    expect(opsOn('users/u-1')).toHaveLength(0);
    expect(state.batchOps.filter((o) => o.path.startsWith('points_ledger/'))).toHaveLength(0);
    expect(opsOn('dlq_points_retry/d-1')[0].data).toMatchObject({ status: 'PROCESSED', attempts: 3 });
  });

  it('ALREADY_PROCESSED_IDEMPOTENTLY: task already completed -> only the DLQ stamp is written', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 0, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    state.tasks.set('task-1', { status: 'completed', assigneeIds: ['u-1'], points: 50 });

    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ ALREADY_PROCESSED_IDEMPOTENTLY: 1 });
    expect(state.batchOps).toEqual([
      {
        op: 'update',
        path: 'dlq_points_retry/d-1',
        data: { status: 'ALREADY_PROCESSED_IDEMPOTENTLY', attempts: 1, processedAt: ST },
      },
    ]);
  });

  it('FAILED_PERMANENTLY: the target task is gone', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'ghost', attempts: 1, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ FAILED_PERMANENTLY: 1 });
    expect(opsOn('dlq_points_retry/d-1')).toEqual([
      {
        op: 'update',
        path: 'dlq_points_retry/d-1',
        data: {
          status: 'FAILED_PERMANENTLY',
          reason: 'Task not found; nothing to retry against',
          attempts: 2,
          parkedAt: ST,
        },
      },
    ]);
  });

  it('FAILED_PERMANENTLY: attempt cap already reached parks WITHOUT another processing attempt', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 5, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    state.tasks.set('task-1', { status: 'in-progress', assigneeIds: ['u-1'], points: 50 });
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ FAILED_PERMANENTLY: 1 });
    expect(body.results[0].attempt).toBe(6);
    const stamp = opsOn('dlq_points_retry/d-1')[0];
    expect(stamp.data.status).toBe('FAILED_PERMANENTLY');
    expect(stamp.data.reason).toBe('Attempt cap already reached (5/5); parking without another try');
    expect(stamp.data.parkedAt).toEqual(ST);
    expect(opsOn('tasks/task-1')).toHaveLength(0);
  });

  it('RETRY_SCHEDULED: a processing error re-queues with attempts+1 and nextRetryAt = now + 5min * 2^attemptsSoFar', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 1, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    state.taskGetError = new Error('firestore unavailable');
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ RETRY_SCHEDULED: 1 });
    expect(body.results[0]).toMatchObject({ status: 'RETRY_SCHEDULED', nextRetryInMs: 600000, lastError: 'firestore unavailable' });
    expect(opsOn('dlq_points_retry/d-1')).toEqual([
      {
        op: 'update',
        path: 'dlq_points_retry/d-1',
        data: {
          status: 'PENDING_RETRY',
          attempts: 2,
          lastAttemptAt: ST,
          lastError: 'firestore unavailable',
          nextRetryAt: { __ts: NOW + 600000, toMillis: expect.any(Function) },
        },
      },
    ]);
  });

  it('FAILED_PERMANENTLY on the final attempt: error at attempts=4 parks with the "Max attempts reached" reason', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 4, payload: { updatesToApply: { status: 'completed' } } } },
    ];
    state.taskGetError = new Error('still down');
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ FAILED_PERMANENTLY: 1 });
    const stamp = opsOn('dlq_points_retry/d-1')[0];
    expect(stamp.data).toEqual({
      status: 'FAILED_PERMANENTLY',
      reason: 'Max attempts reached (5). Last error: still down',
      attempts: 5,
      lastAttemptAt: ST,
      lastError: 'still down',
      parkedAt: ST,
    });
  });

  it('NEEDS_MANUAL_REVIEW: gamification_tx_failed is parked with the exact context reason', async () => {
    state.dlqDocs = [{ id: 'd-1', data: { action: 'gamification_tx_failed', taskId: 'task-9', attempts: 0 } }];
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ NEEDS_MANUAL_REVIEW: 1 });
    expect(opsOn('dlq_points_retry/d-1')[0].data).toEqual({
      status: 'NEEDS_MANUAL_REVIEW',
      reason: 'Retry needs actorUid/taskBefore context that the DLQ record does not carry; replay via executeGamificationTransaction manually',
      attempts: 1,
      parkedAt: ST,
    });
  });

  it('NEEDS_MANUAL_REVIEW: universal_review_approval_failed is parked with the ids-only reason', async () => {
    state.dlqDocs = [{ id: 'd-1', data: { action: 'universal_review_approval_failed', ids: ['x'], attempts: 0 } }];
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ NEEDS_MANUAL_REVIEW: 1 });
    expect(opsOn('dlq_points_retry/d-1')[0].data.reason).toBe(
      'Retry unsupported: DLQ record stores ids only, no payload to replay',
    );
  });

  it('NEEDS_MANUAL_REVIEW: an unknown action is parked with the interpolated reason', async () => {
    state.dlqDocs = [{ id: 'd-1', data: { action: 'mystery_action', attempts: 0 } }];
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ NEEDS_MANUAL_REVIEW: 1 });
    expect(opsOn('dlq_points_retry/d-1')[0].data.reason).toBe(
      "Unknown action 'mystery_action'; no retry handler defined",
    );
  });

  it('non-completion replay (updatesToApply without status=completed): task updates + PROCESSED stamp, no points writes', async () => {
    state.dlqDocs = [
      { id: 'd-1', data: { action: 'task_approval_failed', taskId: 'task-1', attempts: 0, payload: { updatesToApply: { status: 'approved' } } } },
    ];
    state.tasks.set('task-1', { status: 'in-progress', assigneeIds: ['u-1'], points: 50 });
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.outcomes).toEqual({ PROCESSED: 1 });
    expect(opsOn('tasks/task-1')).toEqual([
      { op: 'update', path: 'tasks/task-1', data: { status: 'approved' } },
    ]);
    expect(opsOn('users/u-1')).toHaveLength(0);
  });
});
