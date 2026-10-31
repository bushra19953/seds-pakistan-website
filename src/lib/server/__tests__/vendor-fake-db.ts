/**
 * Test-only adapter over the shared fake Firestore: adds the three
 * Admin SDK surface pieces GG routes use that the shared fake does not
 * implement yet (startAfter cursors, count() aggregates, db.getAll).
 * GA's accepted extension of the shared fake covers .create/orderBy;
 * this wrapper stays local to GG tests (R-18: new files only).
 */
import { createFakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

type AnyQuery = {
  where: (f: string, op: string, v: unknown) => AnyQuery;
  orderBy: (f: string, dir?: string) => AnyQuery;
  limit: (n: number) => AnyQuery;
  get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown>; ref: unknown }>; empty: boolean; size: number }>;
  doc: (id?: string) => unknown;
  add: (data: Record<string, unknown>) => Promise<unknown>;
};

interface QueryState {
  limitN: number | null;
  afterId: string | null;
}

function wrapQuery(q: AnyQuery, state: QueryState): AnyQuery {
  const wrapped: AnyQuery = {
    where: (f, op, v) => wrapQuery(q.where(f, op, v), state),
    orderBy: (f, dir) => wrapQuery(q.orderBy(f, dir), state),
    limit: (n) => wrapQuery(q, { ...state, limitN: n }),
    get: async () => {
      const snap = await q.get();
      let docs = snap.docs;
      if (state.afterId) {
        const idx = docs.findIndex((d) => d.id === state.afterId);
        if (idx >= 0) docs = docs.slice(idx + 1);
      }
      if (state.limitN != null) docs = docs.slice(0, state.limitN);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
    doc: q.doc,
    add: q.add,
  };
  (wrapped as unknown as Record<string, unknown>).startAfter = (docSnap: { id: string }) =>
    wrapQuery(q, { ...state, afterId: docSnap.id });
  (wrapped as unknown as Record<string, unknown>).count = () => ({
    get: async () => {
      const snap = await q.get();
      return { data: () => ({ count: snap.docs.length }) };
    },
  });
  return wrapped;
}

export function createVendorFakeDb(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const raw = createFakeFirestore(seed) as unknown as Record<string, unknown>;
  const rawCollection = raw.collection as (name: string) => AnyQuery;
  return {
    ...raw,
    collection: (name: string) => wrapQuery(rawCollection(name), { limitN: null, afterId: null }),
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map((r) => r.get())),
  };
}

export type VendorFakeDb = ReturnType<typeof createVendorFakeDb>;
