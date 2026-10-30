/**
 * @jest-environment node
 *
 * Read-bleed train 2 (census 23 A2/A3 + census 05 L7): the payload
 * mirror variants in seam-tasks-route. mirrorTaskDocFromData /
 * mirrorTaskDocsFromData must upsert exactly the held doc
 * (sanitized), dedupe ids, no-op when the surface is OFF, swallow
 * adapter failures when NOT primary, and RETHROW them under write
 * primacy (the primary commit gate — an adapter failure, never a
 * re-read failure: this API has no fetcher at all).
 */

import {
  __resetTasksSupaAdapterForTests,
  __setTasksSupaAdapterForTests,
  mirrorTaskDocFromData,
  mirrorTaskDocsFromData,
  type TasksSupaAdapter,
} from '../seam-tasks-route';

const setDocCalls: Array<{ collection: string; id: string; data: any }> = [];
let setDocImpl: (collection: string, id: string, data: any) => Promise<void> = async () => {};

function fakeAdapter(): TasksSupaAdapter {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async (collection: string, id: string, data: any) => {
      setDocCalls.push({ collection, id, data });
      await setDocImpl(collection, id, data);
    }),
    updateDoc: jest.fn(async () => {}),
    deleteDoc: jest.fn(async () => {}),
  };
}

const ENV_KEYS = ['SUPA_SURFACES', 'SUPA_PRIMARY'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  setDocCalls.length = 0;
  setDocImpl = async () => {};
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SUPA_SURFACES = 'tasks';
  delete process.env.SUPA_PRIMARY;
  __setTasksSupaAdapterForTests(fakeAdapter());
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  __resetTasksSupaAdapterForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  (console.warn as jest.Mock).mockRestore?.();
});

describe('mirrorTaskDocFromData', () => {
  it('upserts the held doc, sanitized (Date -> ISO, sentinels dropped)', async () => {
    await mirrorTaskDocFromData('task-1', {
      title: 'Held',
      createdAt: new Date('2026-10-30T00:00:00.000Z'),
      serverStamp: { _methodName: 'serverTimestamp' },
    });
    expect(setDocCalls).toHaveLength(1);
    expect(setDocCalls[0]).toMatchObject({ collection: 'tasks', id: 'task-1' });
    expect(setDocCalls[0].data.title).toBe('Held');
    expect(setDocCalls[0].data.createdAt).toBe('2026-10-30T00:00:00.000Z');
    expect('serverStamp' in setDocCalls[0].data).toBe(false);
  });

  it('swallows adapter failure when tasks is not primary', async () => {
    setDocImpl = async () => {
      throw new Error('adapter down');
    };
    await expect(mirrorTaskDocFromData('task-1', { title: 'x' })).resolves.toBeUndefined();
  });

  it('RETHROWS adapter failure under write primacy', async () => {
    process.env.SUPA_PRIMARY = 'tasks';
    setDocImpl = async () => {
      throw new Error('adapter down');
    };
    await expect(mirrorTaskDocFromData('task-1', { title: 'x' })).rejects.toThrow('adapter down');
  });

  it('is a no-op when the tasks surface flag is OFF', async () => {
    process.env.SUPA_SURFACES = '';
    await mirrorTaskDocFromData('task-1', { title: 'x' });
    expect(setDocCalls).toHaveLength(0);
  });
});

describe('mirrorTaskDocsFromData', () => {
  it('mirrors each entry once, in order, deduped by id', async () => {
    await mirrorTaskDocsFromData([
      ['b', { title: 'B' }],
      ['a', { title: 'A' }],
      ['b', { title: 'B again' }],
    ]);
    expect(setDocCalls.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('accepts a Map (the routes build Map<id, doc>)', async () => {
    await mirrorTaskDocsFromData(
      new Map<string, Record<string, any>>([['m1', { title: 'M' }]])
    );
    expect(setDocCalls.map((c) => c.id)).toEqual(['m1']);
  });
});
