/**
 * @jest-environment node
 *
 * P1 MIRROR LOUDNESS — the fs_applications resync guard runner
 * (src/lib/applications-resync.ts), exercised with a fake Firestore
 * db and a fake Supa adapter injected through the real seam's test
 * point. Zero live reads/writes.
 *
 * Pins:
 *  (i)   dry-run reports the missing id and performs ZERO writes.
 *  (ii)  repair re-mirrors the missing doc verbatim (the adapter
 *        receives the Firestore data) and reports repairedIds.
 *  (iii) a failing repair mirror lands in unhealableIds; the runner
 *        itself does not throw.
 *  (iv)  clean state (identical id sets) reports all-empty lists —
 *        the silence condition for the scheduled guard.
 *  (v)   301 Firestore docs trip the read budget: overBudget=true
 *        and ZERO adapter writes (and no fs listing at all).
 *  (vi)  orphan fs rows are reported, never deleted — even in
 *        repair mode.
 *  (vii) no adapter (surface off / unconfigured) -> null (the route
 *        answers 503).
 */
import {
  runApplicationsResync,
  type ApplicationsResyncDb,
} from '@/lib/applications-resync';
import {
  __setApplicationsSupaAdapterForTests,
  __resetApplicationsSupaAdapterForTests,
  type ApplicationsSupaAdapter,
} from '@/lib/applications-supa';

interface DocSeed {
  id: string;
  data: Record<string, any>;
}

function makeDb(docs: DocSeed[]): ApplicationsResyncDb {
  return {
    collection: (_name: string) => ({
      limit: (n: number) => ({
        get: async () => {
          const sliced = docs.slice(0, n);
          return {
            size: sliced.length,
            docs: sliced.map((d) => ({ id: d.id, data: () => d.data })),
          };
        },
      }),
    }),
  };
}

const setDocCalls: Array<{ collection: string; id: string; data: any }> = [];
const deleteDocCalls: Array<{ collection: string; id: string }> = [];
let listDocsCalls = 0;
let failSetFor: string | null = null;

function makeAdapter(rows: DocSeed[]): ApplicationsSupaAdapter {
  const store = new Map<string, Record<string, any>>(rows.map((r) => [r.id, r.data]));
  return {
    async getDoc(_collection, id) {
      const data = store.get(id);
      return data ? { id, ...data } : null;
    },
    async listDocs(_collection, options = {}) {
      listDocsCalls += 1;
      let docs = Array.from(store.entries())
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (options.startAfter !== undefined) {
        docs = docs.filter((d) => d.id > String(options.startAfter));
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return docs;
    },
    async countDocs() {
      return store.size;
    },
    async setDoc(collection, id, data) {
      setDocCalls.push({ collection, id, data });
      if (failSetFor === id) throw new Error(`fake adapter setDoc failure for ${id}`);
      store.set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(_collection, id, updates) {
      const next = { ...(store.get(id) ?? {}), ...updates };
      store.set(id, next);
      return { id, ...next };
    },
    async deleteDoc(collection, id) {
      deleteDocCalls.push({ collection, id });
      store.delete(id);
    },
  };
}

const APP_1: DocSeed = { id: 'app-1', data: { status: 'pending', fullName: 'One' } };
const APP_2: DocSeed = { id: 'app-2', data: { status: 'pending', fullName: 'Two' } };
const APP_3: DocSeed = { id: 'app-3', data: { status: 'rejected', fullName: 'Three' } };

const savedSurfaces = process.env.SUPA_SURFACES;

describe('runApplicationsResync', () => {
  beforeEach(() => {
    setDocCalls.length = 0;
    deleteDocCalls.length = 0;
    listDocsCalls = 0;
    failSetFor = null;
    process.env.SUPA_SURFACES = 'applications';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetApplicationsSupaAdapterForTests();
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
    (console.error as jest.Mock).mockRestore?.();
    (console.warn as jest.Mock).mockRestore?.();
  });

  it('(i) dry-run: 3 Firestore docs / 2 fs rows -> missingIds=[third], zero adapter writes', async () => {
    __setApplicationsSupaAdapterForTests(makeAdapter([APP_1, APP_2]));
    const report = await runApplicationsResync(makeDb([APP_1, APP_2, APP_3]), 'dry-run');
    expect(report).not.toBeNull();
    expect(report!.mode).toBe('dry-run');
    expect(report!.overBudget).toBe(false);
    expect(report!.firestoreCount).toBe(3);
    expect(report!.supaCount).toBe(2);
    expect(report!.readsUsed).toBe(3);
    expect(report!.missingIds).toEqual(['app-3']);
    expect(report!.repairedIds).toEqual([]);
    expect(report!.unhealableIds).toEqual([]);
    expect(report!.orphanIds).toEqual([]);
    expect(setDocCalls).toHaveLength(0);
    expect(deleteDocCalls).toHaveLength(0);
  });

  it('(ii) repair: inserts the missing doc verbatim and reports repairedIds', async () => {
    __setApplicationsSupaAdapterForTests(makeAdapter([APP_1, APP_2]));
    const report = await runApplicationsResync(makeDb([APP_1, APP_2, APP_3]), 'repair');
    expect(report!.missingIds).toEqual(['app-3']);
    expect(report!.repairedIds).toEqual(['app-3']);
    expect(report!.unhealableIds).toEqual([]);
    expect(setDocCalls).toEqual([
      { collection: 'applications', id: 'app-3', data: { status: 'rejected', fullName: 'Three' } },
    ]);
  });

  it('(iii) repair with a throwing adapter -> unhealableIds=[id], no throw out of the runner', async () => {
    failSetFor = 'app-3';
    __setApplicationsSupaAdapterForTests(makeAdapter([APP_1, APP_2]));
    const report = await runApplicationsResync(makeDb([APP_1, APP_2, APP_3]), 'repair');
    expect(report!.missingIds).toEqual(['app-3']);
    expect(report!.repairedIds).toEqual([]);
    expect(report!.unhealableIds).toEqual(['app-3']);
  });

  it('(iv) clean state: identical id sets -> every list empty (the silence condition)', async () => {
    __setApplicationsSupaAdapterForTests(makeAdapter([APP_1, APP_2, APP_3]));
    const report = await runApplicationsResync(makeDb([APP_1, APP_2, APP_3]), 'repair');
    expect(report!.overBudget).toBe(false);
    expect(report!.missingIds).toEqual([]);
    expect(report!.repairedIds).toEqual([]);
    expect(report!.unhealableIds).toEqual([]);
    expect(report!.orphanIds).toEqual([]);
    expect(setDocCalls).toHaveLength(0);
  });

  it('(v) 301 Firestore docs -> overBudget=true and zero adapter writes', async () => {
    const docs: DocSeed[] = Array.from({ length: 301 }, (_, i) => ({
      id: `app-${i + 1}`,
      data: { status: 'pending' },
    }));
    __setApplicationsSupaAdapterForTests(makeAdapter([]));
    const report = await runApplicationsResync(makeDb(docs), 'repair');
    expect(report!.overBudget).toBe(true);
    expect(report!.firestoreCount).toBeNull();
    expect(report!.supaCount).toBeNull();
    expect(report!.readsUsed).toBe(301);
    expect(report!.missingIds).toEqual([]);
    expect(setDocCalls).toHaveLength(0);
    expect(deleteDocCalls).toHaveLength(0);
    expect(listDocsCalls).toBe(0);
  });

  it('(vi) orphans are reported and never deleted, even in repair mode', async () => {
    __setApplicationsSupaAdapterForTests(
      makeAdapter([APP_1, { id: 'ghost-1', data: { status: 'pending' } }]),
    );
    const report = await runApplicationsResync(makeDb([APP_1]), 'repair');
    expect(report!.orphanIds).toEqual(['ghost-1']);
    expect(report!.missingIds).toEqual([]);
    expect(deleteDocCalls).toHaveLength(0);
  });

  it('(vii) adapter unavailable -> null (route answers 503)', async () => {
    __setApplicationsSupaAdapterForTests(null);
    const report = await runApplicationsResync(makeDb([APP_1]), 'dry-run');
    expect(report).toBeNull();
  });
});
