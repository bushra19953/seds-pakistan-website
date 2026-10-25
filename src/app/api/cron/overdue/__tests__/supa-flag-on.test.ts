/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/overdue (Supabase migration,
 * cluster cron G3): the route runs against the shared Firestore-shaped
 * db handle over the adapter (FakeSupa underneath). Pins the plan §3
 * hotspot: deadlines stored as ISO STRINGS (what the adapter stores)
 * must be selected by deadlineToMillis exactly like Firestore-shaped
 * values — an ISO string with an offset parses to the same millis via
 * the route's own string branch, verified here end-to-end, not assumed.
 * Also covers the workflow-release block (settings get + next-step
 * query) through the handle. Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow, dumpedTimestamp } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };

jest.mock('@/lib/server/cron/g3-data', () => ({
  G3_SURFACE: 'cron-g3',
  getG3Db: () => mockState.handle,
}));

import { GET } from '../route';

const SECRET = 'g3-test-secret';
const HOUR = 60 * 60 * 1000;

function req() {
  return new NextRequest('http://localhost/api/cron/overdue', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('overdue flag ON (Supabase handle)', () => {
  it('marks ISO-string and dumped-timestamp deadlines overdue; future deadline untouched', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_tasks', [
        landingRow('t-iso-past', {
          status: 'pending',
          deadline: new Date(now - 2 * HOUR).toISOString(),
        }),
        landingRow('t-dumped-past', {
          status: 'in-progress',
          deadline: dumpedTimestamp(new Date(now - 3 * HOUR).toISOString()),
        }),
        landingRow('t-future', {
          status: 'pending',
          deadline: new Date(now + 24 * HOUR).toISOString(),
        }),
      ])
      .seed('fs_settings', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.scanned).toBe(3);
    expect(body.newlyMarked).toBe(2);
    expect(body.releaseOnOverdue).toBe(false);

    const byId = new Map(fake.rows('fs_tasks').map((r) => [r.id, r.data]));
    expect(byId.get('t-iso-past')?.status).toBe('overdue');
    expect(typeof byId.get('t-iso-past')?.updatedAt).toBe('string');
    expect(byId.get('t-dumped-past')?.status).toBe('overdue');
    expect(byId.get('t-future')?.status).toBe('pending');
  });

  it('workflow release: unflags the overdue current step and releases the next step', async () => {
    const now = Date.now();
    const fake = new FakeSupa()
      .seed('fs_tasks', [
        landingRow('w1', {
          status: 'pending',
          deadline: new Date(now - HOUR).toISOString(),
          workflowId: 'wf1',
          sequenceIndex: 1,
          isCurrentStep: true,
        }),
        landingRow('w2', {
          status: 'pending',
          deadline: new Date(now + 24 * HOUR).toISOString(),
          workflowId: 'wf1',
          sequenceIndex: 2,
          isCurrentStep: false,
        }),
      ])
      .seed('fs_settings', [
        landingRow('workflow', { releaseOnOverdue: true }),
      ]);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.newlyMarked).toBe(1);
    expect(body.releaseOnOverdue).toBe(true);
    expect(body.stepsReleased).toBe(1);

    const byId = new Map(fake.rows('fs_tasks').map((r) => [r.id, r.data]));
    expect(byId.get('w1')?.status).toBe('overdue');
    expect(byId.get('w1')?.isCurrentStep).toBe(false);
    expect(byId.get('w2')?.isCurrentStep).toBe(true);
    expect(typeof byId.get('w2')?.releasedAt).toBe('string');
  });
});
