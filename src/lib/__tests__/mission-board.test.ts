/**
 * Mission-board client seam pins (read-bleed fix train 2,
 * rbt2-projects) for src/lib/mission-board.ts — the module behind the
 * public projects page's National Mission Board + roadmap counts.
 * All against fakes: zero live reads, zero network.
 *
 * Pins:
 *  - computeMissionStats reproduces the page's original Firestore
 *    listener aggregation EXACTLY: grouping by workflowId with
 *    first-task title/chapter fields, per-workflow progress,
 *    participant dedupe by assigneeId (first-seen order, nameless
 *    dropped), readiness over ALL tasks, distinct chapter count,
 *    workflows sorted by progress desc, recentActivity = top 3 by
 *    updatedAt desc.
 *  - reviveBoardTimestamp restores a Timestamp from every
 *    JSON-carried shape and passes Timestamp-likes / junk through.
 *  - The route fetchers throw on non-200 (caller falls back to
 *    Firestore) and revive updatedAt on the board payload.
 *  - The client flag parses NEXT_PUBLIC_SUPA_SURFACES for 'tasks'.
 */

jest.mock('@/lib/projects-supa', () => ({
  ...jest.requireActual('@/lib/projects-supa'),
  getCurrentUserIdToken: jest.fn(async () => 'test-token'),
}));

import {
  computeMissionStats,
  reviveBoardTimestamp,
  fetchMissionBoardTasksViaRoute,
  fetchProjectTasksViaRoute,
  missionBoardSupaClientEnabled,
} from '@/lib/mission-board';

const ts = (ms: number) => ({ toMillis: () => ms });

function boardTasks(): any[] {
  return [
    // wf-b appears first in input but wf-a must group independently;
    // first task per workflow supplies title/chapter fields.
    { id: 't3', workflowId: 'wf-b', workflowTitle: 'Beta Mission', chapterName: 'IST', chapterId: 'ist', status: 'pending', assigneeId: 'u3', assigneeName: 'Chen', assigneePhoto: null, title: 'B step 1', updatedAt: ts(300) },
    { id: 't1', workflowId: 'wf-a', workflowTitle: 'Alpha Mission', chapterName: 'IST', chapterId: 'ist', status: 'completed', assigneeId: 'u1', assigneeName: 'Amina', assigneePhoto: 'a.png', title: 'A step 1', updatedAt: ts(100) },
    { id: 't2', workflowId: 'wf-a', workflowTitle: 'Alpha Mission (later copy)', chapterName: 'Other', chapterId: 'ist', status: 'in-progress', assigneeId: 'u2', assigneeName: 'Bilal', assigneePhoto: null, title: 'A step 2', updatedAt: ts(500) },
    { id: 't4', workflowId: 'wf-a', workflowTitle: 'Alpha Mission', chapterName: 'IST', chapterId: 'ist', status: 'submitted-for-review', assigneeId: 'u1', assigneeName: 'Amina', assigneePhoto: 'a.png', title: 'A step 3', updatedAt: ts(200) },
    { id: 't5', workflowId: 'wf-b', workflowTitle: 'Beta Mission', chapterName: 'IST', chapterId: 'karachi', status: 'approved', assigneeId: '', assigneeName: '', assigneePhoto: null, title: 'B step 2', updatedAt: ts(400) },
  ];
}

describe('computeMissionStats (verbatim listener aggregation)', () => {
  it('groups by workflowId with first-task title/chapter fields', () => {
    const stats = computeMissionStats(boardTasks());
    expect(stats.activeMissions).toBe(2);
    const alpha = stats.workflows.find((w) => w.id === 'wf-a');
    expect(alpha.title).toBe('Alpha Mission');
    expect(alpha.chapterName).toBe('IST');
    expect(alpha.tasks).toHaveLength(3);
  });

  it('computes per-workflow progress with isStepWorkDone semantics', () => {
    const stats = computeMissionStats(boardTasks());
    const alpha = stats.workflows.find((w) => w.id === 'wf-a');
    const beta = stats.workflows.find((w) => w.id === 'wf-b');
    // alpha: completed + submitted-for-review done of 3 -> 67
    expect(alpha.progress).toBe(67);
    // beta: approved done of 2 -> 50
    expect(beta.progress).toBe(50);
    // sorted by progress desc
    expect(stats.workflows.map((w) => w.id)).toEqual(['wf-a', 'wf-b']);
  });

  it('dedupes participants by assigneeId, first-seen order, drops nameless', () => {
    const stats = computeMissionStats(boardTasks());
    const alpha = stats.workflows.find((w) => w.id === 'wf-a');
    expect(alpha.participants).toEqual([
      { name: 'Amina', photo: 'a.png' },
      { name: 'Bilal', photo: null },
    ]);
    const beta = stats.workflows.find((w) => w.id === 'wf-b');
    // u3 Chen kept; the ''-assignee task contributes no participant.
    expect(beta.participants).toEqual([{ name: 'Chen', photo: null }]);
  });

  it('readiness spans ALL tasks; chapters are the distinct chapterId set', () => {
    const stats = computeMissionStats(boardTasks());
    // done: t1 completed, t4 submitted-for-review, t5 approved = 3/5
    expect(stats.readiness).toBe(60);
    expect(stats.activeChapters).toBe(2); // ist, karachi
  });

  it('recentActivity is the top 3 by updatedAt desc', () => {
    const stats = computeMissionStats(boardTasks());
    expect(stats.recentActivity.map((t) => t.id)).toEqual(['t2', 't5', 't3']);
  });

  it('handles the empty set exactly like the listener did', () => {
    expect(computeMissionStats([])).toEqual({
      activeMissions: 0,
      readiness: 0,
      activeChapters: 0,
      workflows: [],
      recentActivity: [],
    });
  });

  it('skips workflow-less tasks for grouping but keeps them in readiness', () => {
    const stats = computeMissionStats([
      { id: 'x1', status: 'completed', updatedAt: ts(10) },
      { id: 'x2', workflowId: 'wf-a', workflowTitle: 'A', status: 'pending', updatedAt: ts(20) },
    ]);
    expect(stats.activeMissions).toBe(1);
    expect(stats.readiness).toBe(50); // 1 done of ALL 2 tasks
  });
});

describe('reviveBoardTimestamp', () => {
  it('passes Timestamp-likes through untouched', () => {
    const v = { toMillis: () => 42 };
    expect(reviveBoardTimestamp(v)).toBe(v);
  });

  it('revives { seconds, nanoseconds } (the seam JSON shape)', () => {
    const out = reviveBoardTimestamp({ seconds: 1700000000, nanoseconds: 500000000 });
    expect(out.toMillis()).toBe(1700000000500);
  });

  it('revives { _seconds, _nanoseconds } (the dumped shape)', () => {
    const out = reviveBoardTimestamp({ _seconds: 1700000000, _nanoseconds: 250000000 });
    expect(out.toMillis()).toBe(1700000000250);
  });

  it('revives ISO strings and epoch numbers; passes junk through', () => {
    expect(reviveBoardTimestamp('2023-11-14T22:13:20.000Z').toMillis()).toBe(1700000000000);
    expect(reviveBoardTimestamp(1700000000000).toMillis()).toBe(1700000000000);
    expect(reviveBoardTimestamp('not a date')).toBe('not a date');
    expect(reviveBoardTimestamp(null)).toBeNull();
    expect(reviveBoardTimestamp(undefined)).toBeUndefined();
  });
});

describe('route fetchers', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('board fetch revives updatedAt and returns the projected tasks', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        tasks: [
          { id: 't1', workflowId: 'wf-a', status: 'completed', updatedAt: { seconds: 1700000000, nanoseconds: 0 } },
        ],
      }),
    })) as any;
    const tasks = await fetchMissionBoardTasksViaRoute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].updatedAt.toMillis()).toBe(1700000000000);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/public/mission-board');
  });

  it('board fetch throws on non-200 so the caller falls back', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    await expect(fetchMissionBoardTasksViaRoute()).rejects.toThrow('404');
  });

  it('project fetch sends the bearer token and returns tasks', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ tasks: [{ id: 't9', status: 'pending' }] }),
    })) as any;
    const tasks = await fetchProjectTasksViaRoute('proj 1');
    expect(tasks).toEqual([{ id: 't9', status: 'pending' }]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/public/mission-board?projectId=proj%201');
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('project fetch throws on 403 so a non-manager falls back', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as any;
    await expect(fetchProjectTasksViaRoute('p1')).rejects.toThrow('403');
  });
});

describe('missionBoardSupaClientEnabled', () => {
  const KEY = 'NEXT_PUBLIC_SUPA_SURFACES';
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is OFF when unset and ON when tasks is named', () => {
    delete process.env[KEY];
    expect(missionBoardSupaClientEnabled()).toBe(false);
    process.env[KEY] = 'projects,tasks';
    expect(missionBoardSupaClientEnabled()).toBe(true);
    process.env[KEY] = 'projects';
    expect(missionBoardSupaClientEnabled()).toBe(false);
  });
});
