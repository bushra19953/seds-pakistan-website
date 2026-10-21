/**
 * Compact in-memory Firestore fake for finance tests.
 *
 * Supports the surface the finance module uses: collection/doc refs,
 * chained where/orderBy/limit, get/add, doc get/set/update/delete,
 * subcollections (events/{id}/registrations), write batches, and
 * runTransaction (applies immediately; sufficient for unit tests).
 *
 * Pair with jest mocks:
 *   jest.mock('firebase-admin/firestore', () => ({
 *     FieldValue: {
 *       serverTimestamp: () => ({ __serverTimestamp: true }),
 *       arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
 *     },
 *   }));
 */

type DocData = Record<string, unknown>;

function resolveValue(v: unknown, existing: unknown): unknown {
  if (v && typeof v === 'object') {
    const m = v as Record<string, unknown>;
    if (m.__serverTimestamp) return new Date();
    if ('__arrayUnion' in m) {
      const arr = Array.isArray(existing) ? [...(existing as unknown[])] : [];
      if (!arr.includes(m.__arrayUnion)) arr.push(m.__arrayUnion);
      return arr;
    }
    if (Array.isArray(v)) return v.map((x) => resolveValue(x, undefined));
  }
  return v;
}

function resolveData(data: DocData, existing: DocData = {}): DocData {
  const out: DocData = {};
  for (const [k, val] of Object.entries(data)) out[k] = resolveValue(val, existing[k]);
  return out;
}

export interface FakeDocRef {
  id: string;
  path: string;
  get: () => Promise<{ exists: boolean; id: string; data: () => DocData | undefined; ref: FakeDocRef }>;
  set: (data: DocData, opts?: { merge?: boolean }) => Promise<void>;
  update: (data: DocData) => Promise<void>;
  delete: () => Promise<void>;
  collection: (name: string) => FakeCollectionRef;
}

export interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  orderBy: (field: string, dir?: string) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: Array<{ id: string; data: () => DocData; ref: FakeDocRef }>; empty: boolean; size: number }>;
}

export interface FakeCollectionRef extends FakeQuery {
  doc: (id?: string) => FakeDocRef;
  add: (data: DocData) => Promise<FakeDocRef>;
}

export function createFakeFirestore(seed: Record<string, Record<string, DocData>> = {}) {
  // store keyed by collection PATH (supports subcollections), then doc id
  const store = new Map<string, Map<string, DocData>>();
  let autoId = 0;

  for (const [colPath, docs] of Object.entries(seed)) {
    const m = new Map<string, DocData>();
    for (const [id, data] of Object.entries(docs)) m.set(id, { ...data });
    store.set(colPath, m);
  }

  const colMap = (path: string) => {
    if (!store.has(path)) store.set(path, new Map());
    return store.get(path)!;
  };

  function docRef(colPath: string, id: string): FakeDocRef {
    const ref: FakeDocRef = {
      id,
      path: `${colPath}/${id}`,
      async get() {
        const data = colMap(colPath).get(id);
        return { exists: data !== undefined, id, data: () => data, ref };
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        const existing = colMap(colPath).get(id) ?? {};
        colMap(colPath).set(id, opts?.merge ? { ...existing, ...resolveData(data, existing) } : resolveData(data, existing));
      },
      async update(data: DocData) {
        const existing = colMap(colPath).get(id);
        if (!existing) throw new Error(`No document to update: ${colPath}/${id}`);
        colMap(colPath).set(id, { ...existing, ...resolveData(data, existing) });
      },
      async delete() {
        colMap(colPath).delete(id);
      },
      collection: (name: string) => collectionRef(`${colPath}/${id}/${name}`),
    };
    return ref;
  }

  function makeQuery(colPath: string, filters: Array<[string, string, unknown]> = [], order: [string, string] | null = null, lim: number | null = null): FakeQuery {
    return {
      where: (f, op, v) => makeQuery(colPath, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir = 'asc') => makeQuery(colPath, filters, [f, dir], lim),
      limit: (n) => makeQuery(colPath, filters, order, n),
      async get() {
        let rows = [...colMap(colPath).entries()].map(([id, data]) => ({ id, data }));
        for (const [field, op, value] of filters) {
          rows = rows.filter(({ data }) => {
            const actual = data[field];
            if (op === '==') return actual === value;
            if (op === '!=') return actual !== value;
            if (op === 'in') return Array.isArray(value) && value.includes(actual);
            if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value);
            if (op === '>=') return (actual as never) >= (value as never);
            if (op === '<=') return (actual as never) <= (value as never);
            if (op === '>') return (actual as never) > (value as never);
            if (op === '<') return (actual as never) < (value as never);
            return false;
          });
        }
        if (order) {
          const [field, dir] = order;
          rows.sort((a, b) => {
            const av = a.data[field] as never;
            const bv = b.data[field] as never;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map(({ id, data }) => ({ id, data: () => data, ref: docRef(colPath, id) })),
          empty: rows.length === 0,
          size: rows.length,
        };
      },
    };
  }

  function collectionRef(path: string): FakeCollectionRef {
    const q = makeQuery(path);
    return {
      ...q,
      where: q.where,
      orderBy: q.orderBy,
      limit: q.limit,
      get: q.get,
      doc: (id?: string) => docRef(path, id ?? `auto-${++autoId}`),
      async add(data: DocData) {
        const ref = docRef(path, `auto-${++autoId}`);
        await ref.set(data);
        return ref;
      },
    };
  }

  function batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) => ops.push(() => ref.set(data, opts)),
      update: (ref: FakeDocRef, data: DocData) => ops.push(() => ref.update(data)),
      delete: (ref: FakeDocRef) => ops.push(() => ref.delete()),
      create: (ref: FakeDocRef, data: DocData) => ops.push(() => ref.set(data)),
      async commit() {
        for (const op of ops) await op();
      },
    };
  }

  const db = {
    collection: (name: string) => collectionRef(name),
    doc: (path: string) => {
      const parts = path.split('/');
      const id = parts.pop()!;
      return docRef(parts.join('/'), id);
    },
    batch,
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      // Buffered writes: applied only when fn resolves, discarded when it
      // throws - this emulates Firestore transaction atomicity so tests can
      // prove "applies the change, or none on injected failure".
      const ops: Array<() => Promise<void>> = [];
      const existsSync = (ref: FakeDocRef) => {
        const idx = ref.path.lastIndexOf('/');
        return colMap(ref.path.slice(0, idx)).has(ref.path.slice(idx + 1));
      };
      const tx = {
        get: (ref: FakeDocRef) => ref.get(),
        set: (ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) => ops.push(() => ref.set(data, opts)),
        update: (ref: FakeDocRef, data: DocData) => {
          // Firestore update() fails on a missing doc; surface that inside
          // the callback so the buffered writes are discarded atomically.
          if (!existsSync(ref)) throw new Error(`No document to update: ${ref.path}`);
          ops.push(() => ref.update(data));
        },
        delete: (ref: FakeDocRef) => ops.push(() => ref.delete()),
        create: (ref: FakeDocRef, data: DocData) => ops.push(() => ref.set(data)),
      };
      const result = await fn(tx);
      for (const op of ops) await op();
      return result;
    },
    // test helpers: raw store access + seeding
    __store: store,
    __doc: (colPath: string, id: string) => colMap(colPath).get(id),
    __seed: (colPath: string, id: string, data: DocData) => {
      colMap(colPath).set(id, { ...data });
    },
  };

  return db;
}

export type FakeFirestore = ReturnType<typeof createFakeFirestore>;
