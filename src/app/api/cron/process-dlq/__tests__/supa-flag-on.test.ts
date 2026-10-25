/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/process-dlq (Supabase migration,
 * cluster cron G3): the route runs against the shared Firestore-shaped
 * db handle over the adapter (FakeSupa underneath) instead of Firestore.
 * Asserts the write SET the contracts pin for the Firestore path lands
 * in the fs_* tables identically:
 *  - PROCESSED replay: payload.updatesToApply + completedAt on the task,
 *    user points increment + points_ledger row ONLY when the ledger has
 *    no (user_id, task_id) entry yet (the count() existence guard),
 *  - ALREADY_PROCESSED_IDEMPOTENTLY when the task is already completed
 *    (no points writes at all),
 *  - ledger-guard path: task completes but points are NOT re-awarded
 *    when a ledger entry already exists.
 * Zero live reads. CRON_SECRET below is a dummy test fixture value.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockAdmin = require('firebase-admin');
const mockState = { handle: null as unknown };

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  admin: mockAdmin,
}));

jest.mock('@/lib/server/cron/g3-data', () => ({
  G3_SURFACE: 'cron-g3',
  getG3Db: () => mockState.handle,
}));

import { GET } from '../route';

const SECRET = 'g3-test-secret';

function makeHandle(fake: FakeSupa) {
  return createSupaDbHandle(createSupaAdapter(fake as unknown as SupabaseClient));
}

function req() {
  return new NextRequest('http://localhost/api/cron/process-dlq', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('process-dlq flag ON (Supabase handle)', () => {
  it('PROCESSED replay: task updates, points increment, ledger row, dlq stamp', async () => {
    const fake = new FakeSupa()
      .seed('fs_dlq_points_retry', [
        landingRow('d1', {
          status: 'PENDING_RETRY',
          action: 'task_approval_failed',
          taskId: 'task1',
          attempts: 0,
          payload: { updatesToApply: { status: 'completed' } },
        }),
      ])
      .seed('fs_tasks', [
        landingRow('task1', {
          status: 'in-progress',
          assigneeIds: ['u1'],
          points: 50,
        }),
      ])
      .seed('fs_users', [
        landingRow('u1', { total_points: 10, points: 10, tasksCompletedCount: 2 }),
      ])
      .seed('fs_points_ledger', []);
    mockState.handle = makeHandle(fake);

    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.outcomes).toEqual({ PROCESSED: 1 });

    const task = fake.rows('fs_tasks')[0].data;
    expect(task.status).toBe('completed');
    expect(typeof task.completedAt).toBe('string');

    const user = fake.rows('fs_users')[0].data;
    expect(user.total_points).toBe(60);
    expect(user.points).toBe(60);
    expect(user.tasksCompletedCount).toBe(3);

    const ledger = fake.rows('fs_points_ledger');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data).toMatchObject({
      user_id: 'u1',
      task_id: 'task1',
      points_awarded: 50,
      status: 'PROCESSED',
    });

    const dlq = fake.rows('fs_dlq_points_retry')[0].data;
    expect(dlq.status).toBe('PROCESSED');
    expect(dlq.attempts).toBe(1);
    expect(typeof dlq.processedAt).toBe('string');
  });

  it('ALREADY_PROCESSED_IDEMPOTENTLY: completed task yields no points writes', async () => {
    const fake = new FakeSupa()
      .seed('fs_dlq_points_retry', [
        landingRow('d2', {
          status: 'PENDING_RETRY',
          action: 'task_approval_failed',
          taskId: 'task2',
          attempts: 0,
          payload: { updatesToApply: { status: 'completed' } },
        }),
      ])
      .seed('fs_tasks', [
        landingRow('task2', { status: 'completed', assigneeIds: ['u1'], points: 50 }),
      ])
      .seed('fs_users', [
        landingRow('u1', { total_points: 10, points: 10, tasksCompletedCount: 2 }),
      ])
      .seed('fs_points_ledger', []);
    mockState.handle = makeHandle(fake);

    const res = await GET(req());
    const body = await res.json();
    expect(body.outcomes).toEqual({ ALREADY_PROCESSED_IDEMPOTENTLY: 1 });
    expect(fake.rows('fs_points_ledger')).toHaveLength(0);
    expect(fake.rows('fs_users')[0].data.total_points).toBe(10);
    expect(fake.rows('fs_dlq_points_retry')[0].data.status).toBe(
      'ALREADY_PROCESSED_IDEMPOTENTLY',
    );
  });

  it('ledger guard: existing (user_id, task_id) entry blocks re-award but task still completes', async () => {
    const fake = new FakeSupa()
      .seed('fs_dlq_points_retry', [
        landingRow('d3', {
          status: 'PENDING_RETRY',
          action: 'task_approval_failed',
          taskId: 'task3',
          attempts: 1,
          payload: { updatesToApply: { status: 'completed' } },
        }),
      ])
      .seed('fs_tasks', [
        landingRow('task3', { status: 'in-progress', assigneeIds: ['u1'], points: 50 }),
      ])
      .seed('fs_users', [
        landingRow('u1', { total_points: 60, points: 60, tasksCompletedCount: 3 }),
      ])
      .seed('fs_points_ledger', [
        landingRow('l1', { user_id: 'u1', task_id: 'task3', points_awarded: 50 }),
      ]);
    mockState.handle = makeHandle(fake);

    const res = await GET(req());
    const body = await res.json();
    expect(body.outcomes).toEqual({ PROCESSED: 1 });
    expect(fake.rows('fs_tasks')[0].data.status).toBe('completed');
    expect(fake.rows('fs_points_ledger')).toHaveLength(1);
    expect(fake.rows('fs_users')[0].data.total_points).toBe(60);
  });
});
