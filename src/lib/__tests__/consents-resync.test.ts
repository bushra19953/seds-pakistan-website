/**
 * @jest-environment node
 *
 * The fs_consent_requests resync guard runner
 * (src/lib/consents-resync.ts), exercised with a fake Firestore db
 * and a fake Supa adapter injected through the real seam's test
 * point. Zero live reads/writes. Modeled on applications-resync.test.ts.
 *
 * Pins:
 *  (i)   dry-run reports the missing id and performs ZERO writes.
 *  (ii)  repair re-mirrors the missing doc verbatim and reports repairedIds.
 *  (iii) a failing repair mirror lands in unhealableIds; the runner
 *        itself does not throw.
 *  (iv)  clean state reports all-empty lists (the silence condition).
 *  (v)   301 Firestore docs trip the read budget: overBudget=true
 *        and ZERO adapter writes (and no fs listing at all).
 *  (vi)  orphan fs rows are reported, never deleted — even in repair mode.
 *  (vii) no adapter (surface off) -> null (the route answers 503).
 */
import {
  runConsentsResync,
  type ConsentsResyncDb,
} from '@/lib/consents-resync';
import {
  __resetConsentsSupaAdapterForTests,
  __setConsentsSupaAdapterForTests,
  type ConsentsSupaAdapter,
} from '@/lib/server/consents-supa';

interface DocSeed {
  id: string;
  data: Record<string, any>;
}

function makeDb(docs: DocSeed[]): ConsentsResyncDb {
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

const setDocCalls: Array<{ id: string; data: any }> = [];
const deleteDocCalls: Array<{ id: string }> = [];
let listDocsCalls = 0;
let failSetFor: string | null = null;

function makeAdapter(rows: DocSeed[]): ConsentsSupaAdapter {
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
      if ((options as any).startAfter !== undefined) {
        docs = docs.filter((d) => d.id > String((options as any).startAfter));
      }
      if (options.limit !== undefined) docs = docs.slice(0, options.limit);
      return docs;
    },
    async setDoc(_collection, id, data) {
      setDocCalls.push({ id, data });
      if (failSetFor === id) throw new Error(`fake adapter setDoc failure for ${id}`);
      store.set(id, { ...data });
      return { id, ...data };
    },
    async updateDoc(_collection, id, updates) {
      const next = { ...(store.get(id) ?? {}), ...updates };
      store.set(id, next);
      return { id, ...next };
    },
    async deleteDoc(_collection, id) {
      deleteDocCalls.push({ id });
      store.delete(id);
    },
  };
}

let savedSurfaces: string | undefined;
beforeEach(() => {
  savedSurfaces = process.env.SUPA_SURFACES;
  process.env.SUPA_SURFACES = 'consents';
  setDocCalls.length = 0;
  deleteDocCalls.length = 0;
  listDocsCalls = 0;
  failSetFor = null;
});
afterEach(() => {
  if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
  else process.env.SUPA_SURFACES = savedSurfaces;
  __resetConsentsSupaAdapterForTests();
});

const FS_DOCS: DocSeed[] = [
  { id: 'a', data: { status: 'consented', requestNumber: 'FC-2026-0001' } },
  { id: 'b', data: { status: 'pending', requestNumber: 'FC-2026-0002' } },
];
const MIRROR_DOCS: DocSeed[] = [
  { id: 'a', data: { status: 'consented', requestNumber: 'FC-2026-0001' } },
];

describe('runConsentsResync', () => {
  it('(i) dry-run reports the missing id and writes nothing', async () => {
    __setConsentsSupaAdapterForTests(makeAdapter(MIRROR_DOCS));
    const report = await runConsentsResync(makeDb(FS_DOCS), 'dry-run');
    expect(report).toMatchObject({
      mode: 'dry-run', overBudget: false, firestoreCount: 2, supaCount: 1,
      missingIds: ['b'], repairedIds: [], unhealableIds: [], orphanIds: [], readsUsed: 2,
    });
    expect(setDocCalls).toHaveLength(0);
  });

  it('(ii) repair re-mirrors the missing doc verbatim', async () => {
    __setConsentsSupaAdapterForTests(makeAdapter(MIRROR_DOCS));
    const report = await runConsentsResync(makeDb(FS_DOCS), 'repair');
    expect(report?.missingIds).toEqual(['b']);
    expect(report?.repairedIds).toEqual(['b']);
    expect(report?.unhealableIds).toEqual([]);
    expect(setDocCalls).toEqual([
      { id: 'b', data: { status: 'pending', requestNumber: 'FC-2026-0002' } },
    ]);
  });

  it('(iii) a failing repair lands in unhealableIds without throwing', async () => {
    failSetFor = 'b';
    __setConsentsSupaAdapterForTests(makeAdapter(MIRROR_DOCS));
    const report = await runConsentsResync(makeDb(FS_DOCS), 'repair');
    expect(report?.repairedIds).toEqual([]);
    expect(report?.unhealableIds).toEqual(['b']);
  });

  it('(iv) clean state reports all-empty lists', async () => {
    __setConsentsSupaAdapterForTests(makeAdapter(FS_DOCS));
    const report = await runConsentsResync(makeDb(FS_DOCS), 'dry-run');
    expect(report).toMatchObject({
      overBudget: false, firestoreCount: 2, supaCount: 2,
      missingIds: [], orphanIds: [], repairedIds: [], unhealableIds: [],
    });
  });

  it('(v) 301 docs trip the budget: overBudget, zero writes, no fs listing', async () => {
    const many: DocSeed[] = Array.from({ length: 301 }, (_, i) => ({
      id: `doc-${i}`,
      data: { status: 'pending' },
    }));
    __setConsentsSupaAdapterForTests(makeAdapter([]));
    const report = await runConsentsResync(makeDb(many), 'repair');
    expect(report?.overBudget).toBe(true);
    expect(report?.firestoreCount).toBeNull();
    expect(report?.readsUsed).toBe(301);
    expect(setDocCalls).toHaveLength(0);
    expect(listDocsCalls).toBe(0);
  });

  it('(vi) orphans are reported, never deleted, even in repair mode', async () => {
    __setConsentsSupaAdapterForTests(
      makeAdapter([...MIRROR_DOCS, { id: 'ghost', data: { status: 'consented' } }]),
    );
    const report = await runConsentsResync(makeDb(FS_DOCS), 'repair');
    expect(report?.orphanIds).toEqual(['ghost']);
    expect(deleteDocCalls).toHaveLength(0);
  });

  it('(vii) surface off -> null (route answers 503)', async () => {
    delete process.env.SUPA_SURFACES;
    __setConsentsSupaAdapterForTests(makeAdapter(MIRROR_DOCS));
    const report = await runConsentsResync(makeDb(FS_DOCS), 'dry-run');
    expect(report).toBeNull();
  });
});
