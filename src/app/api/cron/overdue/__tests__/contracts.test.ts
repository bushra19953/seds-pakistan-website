/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET /api/cron/overdue —
 * companion to the existing route.test.ts in this folder (which pins
 * ONLY the cron-bearer auth arms). This file pins the scan/write
 * behaviour:
 *
 *  - Auth shape: this route has NO manual/session arm at all — a
 *    request without the CRON_SECRET bearer is 401, full stop.
 *  - The write set: tasks past deadline are batch-updated with
 *    exactly { status: 'overdue', updatedAt: <run Date> }.
 *  - The counts/skippedDetails response projection, including the
 *    proof-uploaded skip and deadline normalisation (Date, epoch,
 *    ISO string read as PKT when offset-less).
 *  - The settings/workflow release step (releaseOnOverdue).
 *  - The db-down error body, which unlike sibling crons is
 *    { success: false, error }.
 *
 * Firestore is a fake in-memory boundary; zero live reads.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const state = {
  dbAvailable: true,
  tasks: [] as Row[],
  workflowSettings: null as Record<string, any> | null,
  batchUpdates: [] as Array<{ path: string; data: any }>,
  batchCommits: 0,
};

function matches(row: Row, filters: Array<[string, string, any]>): boolean {
  return filters.every(([field, op, value]) => {
    const v = row.data[field];
    if (op === '==') return v === value;
    if (op === 'in') return Array.isArray(value) && value.includes(v);
    return false;
  });
}

function makeQuery(rows: Row[], filters: Array<[string, string, any]> = [], limitN: number | null = null): any {
  const q: any = {
    where: (f: string, op: string, v: any) => makeQuery(rows, [...filters, [f, op, v]], limitN),
    limit: (n: number) => makeQuery(rows, filters, n),
    get: async () => {
      let out = rows.filter((r) => matches(r, filters));
      if (limitN !== null) out = out.slice(0, limitN);
      const docs = out.map((r) => ({
        id: r.id,
        data: () => r.data,
        ref: { path: `tasks/${r.id}` },
      }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
  return q;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'tasks') return makeQuery(state.tasks);
    if (name === 'settings') {
      return {
        doc: (id: string) => ({
          get: async () => ({
            exists: state.workflowSettings !== null && id === 'workflow',
            data: () => state.workflowSettings ?? undefined,
          }),
        }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  batch: () => ({
    update: (ref: any, data: any) => {
      state.batchUpdates.push({ path: ref.path, data });
    },
    commit: async () => {
      state.batchCommits += 1;
    },
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => (state.dbAvailable ? mockDb : null)),
}));

jest.mock('@/lib/server/bug4-proof-guards', () => ({
  taskHasProofUploaded: jest.fn((data: any) => data?.__proof === true),
}));

import { GET } from '../route';

const SECRET = 'test-cron-secret';
const PAST = new Date(Date.now() - 3600 * 1000);
const FUTURE = new Date(Date.now() + 3600 * 1000);

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cron/overdue', { method: 'GET', headers });
}

const cronHeaders = { authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.dbAvailable = true;
  state.tasks = [];
  state.workflowSettings = null;
  state.batchUpdates = [];
  state.batchCommits = 0;
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/overdue — migration contract', () => {
  it('no manual arm exists: a request without the cron bearer is 401 { error: "Unauthorized" } and nothing is written', async () => {
    state.tasks = [{ id: 't-1', data: { status: 'pending', deadline: PAST } }];
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.batchUpdates).toHaveLength(0);
  });

  it('db unavailable -> 500 { success: false, error: "Database initialization failed" } (shape differs from sibling crons)', async () => {
    state.dbAvailable = false;
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Database initialization failed' });
  });

  it('scan: counts, write set and response projection for a mixed task set', async () => {
    state.tasks = [
      { id: 't-past', data: { status: 'pending', deadline: PAST } },
      { id: 't-iso', data: { status: 'in-progress', individualDeadline: '2000-01-01T00:00:00' } }, // offset-less = PKT, long past
      { id: 't-future', data: { status: 'pending', deadline: FUTURE } },
      { id: 't-none', data: { status: 'pending' } },
      { id: 't-junk', data: { status: 'pending', deadline: 'not-a-date' } },
      { id: 't-proof', data: { status: 'pending', deadline: PAST, __proof: true } },
    ];
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.checkedAt).toBe('string');
    expect(body).toMatchObject({
      scanned: 6,
      noDeadline: 1,
      unparseableDeadline: 1,
      notYetDue: 1,
      alreadyOverdue: 0,
      newlyMarked: 2,
      proofUploadedSkipped: 1,
      releaseOnOverdue: false,
      stepsReleased: 0,
    });
    expect(body.skippedDetails).toEqual([
      { taskId: 't-proof', reason: 'proof uploaded; awaiting review' },
    ]);
    // Write set: exactly the two due tasks, one batch, one commit,
    // each update exactly { status: 'overdue', updatedAt: <Date> }.
    expect(state.batchCommits).toBe(1);
    expect(state.batchUpdates.map((u) => u.path).sort()).toEqual(['tasks/t-iso', 'tasks/t-past']);
    for (const u of state.batchUpdates) {
      expect(Object.keys(u.data).sort()).toEqual(['status', 'updatedAt']);
      expect(u.data.status).toBe('overdue');
      expect(u.data.updatedAt).toBeInstanceOf(Date);
    }
    // Both updates carry the SAME run timestamp object value.
    expect(state.batchUpdates[0].data.updatedAt.getTime()).toBe(state.batchUpdates[1].data.updatedAt.getTime());
  });

  it('epoch-seconds deadlines are normalised (seconds are multiplied to millis)', async () => {
    state.tasks = [
      { id: 't-epoch', data: { status: 'pending', deadline: Math.floor((Date.now() - 3600 * 1000) / 1000) } },
    ];
    const res = await GET(req(cronHeaders));
    expect((await res.json()).newlyMarked).toBe(1);
    expect(state.batchUpdates.map((u) => u.path)).toEqual(['tasks/t-epoch']);
  });

  it('empty scan: all counts zero, no batch writes, no commits', async () => {
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 0, newlyMarked: 0, proofUploadedSkipped: 0, skippedDetails: [] });
    expect(state.batchUpdates).toHaveLength(0);
    expect(state.batchCommits).toBe(0);
  });

  it('releaseOnOverdue enabled: current steps are unflagged and the next step is released', async () => {
    state.workflowSettings = { releaseOnOverdue: true };
    state.tasks = [
      { id: 'step-0', data: { status: 'overdue', workflowId: 'wf-1', isCurrentStep: true, sequenceIndex: 0 } },
      { id: 'step-1', data: { status: 'pending', workflowId: 'wf-1', isCurrentStep: false, sequenceIndex: 1, deadline: FUTURE } },
    ];
    const res = await GET(req(cronHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.releaseOnOverdue).toBe(true);
    expect(body.stepsReleased).toBe(1);
    const unflag = state.batchUpdates.find((u) => u.path === 'tasks/step-0');
    expect(unflag?.data.isCurrentStep).toBe(false);
    expect(unflag?.data.updatedAt).toBeInstanceOf(Date);
    const release = state.batchUpdates.find((u) => u.path === 'tasks/step-1');
    expect(release?.data.isCurrentStep).toBe(true);
    expect(release?.data.releasedAt).toBeInstanceOf(Date);
    expect(release?.data.updatedAt).toBeInstanceOf(Date);
  });

  it('releaseOnOverdue enabled but the next step is already current: no release write, stepsReleased 0', async () => {
    state.workflowSettings = { releaseOnOverdue: true };
    state.tasks = [
      { id: 'step-0', data: { status: 'overdue', workflowId: 'wf-1', isCurrentStep: true, sequenceIndex: 0 } },
      { id: 'step-1', data: { status: 'pending', workflowId: 'wf-1', isCurrentStep: true, sequenceIndex: 1, deadline: FUTURE } },
    ];
    const res = await GET(req(cronHeaders));
    const body = await res.json();
    expect(body.stepsReleased).toBe(0);
    expect(state.batchUpdates.find((u) => u.path === 'tasks/step-1')).toBeUndefined();
  });
});
