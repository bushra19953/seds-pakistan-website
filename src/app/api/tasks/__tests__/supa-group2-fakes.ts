/**
 * Shared fakes for the tasks group-2 Supa seam tests.
 *
 * One in-memory store backs BOTH the fake Firestore db and the fake
 * Supabase adapter, keyed by collection path ('tasks', 'users',
 * 'tasks/t1/activity', ...). A `ts()` converter per shape renders
 * timestamps the way each backend delivers them: Firestore Timestamp-like
 * objects for the Firestore store, ISO strings for the Supa store.
 */

export type Store = Map<string, Map<string, any>>;

export function makeStore(): Store {
  return new Map();
}

export function put(store: Store, path: string, id: string, data: any): void {
  if (!store.has(path)) store.set(path, new Map());
  store.get(path)!.set(id, data);
}

/** Timestamp value for the fake Firestore store. */
export function fsTs(iso: string): any {
  const d = new Date(iso);
  return {
    toDate: () => new Date(d.getTime()),
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
  };
}

/** Timestamp value for the fake Supa store (jsonb: ISO string). */
export function supaTs(iso: string): any {
  return iso;
}

function toTime(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return 0;
}

export function matchesWhere(data: any, id: string, clause: any[]): boolean {
  const [field, op, value] = clause;
  const v = field === '__id__' ? id : data?.[field];
  switch (op) {
    case '==':
      return v === value;
    case '!=':
      return v !== value;
    case 'in':
      return Array.isArray(value) && value.includes(v);
    case 'array-contains':
      return Array.isArray(v) && v.includes(value);
    default:
      return false;
  }
}

function applyOrderLimit(
  entries: Array<[string, any]>,
  orderBy: any,
  limit?: number,
): Array<[string, any]> {
  let out = [...entries];
  const specs = !orderBy
    ? []
    : Array.isArray(orderBy)
      ? orderBy
      : [typeof orderBy === 'string' ? { field: orderBy } : orderBy];
  for (const spec of [...specs].reverse()) {
    const dir = spec.direction === 'desc' || spec.dir === 'desc' ? -1 : 1;
    out.sort((a, b) => dir * (toTime(a[1]?.[spec.field]) - toTime(b[1]?.[spec.field])) || a[0].localeCompare(b[0]));
  }
  if (typeof limit === 'number') out = out.slice(0, limit);
  return out;
}

/* --------------------------------------------------------- fake Firestore */

let idCounter = 0;

export function makeFirestoreDb(store: Store): any {
  const coll = (path: string): Map<string, any> => {
    if (!store.has(path)) store.set(path, new Map());
    return store.get(path)!;
  };

  function makeDocRef(path: string, id: string): any {
    return {
      id,
      get: async () => {
        const d = coll(path).get(id);
        return { id, exists: d !== undefined, data: () => d };
      },
      collection: (sub: string) => makeQuery(`${path}/${id}/${sub}`),
      set: async (data: any) => {
        coll(path).set(id, data);
      },
      update: async (data: any) => {
        coll(path).set(id, { ...(coll(path).get(id) || {}), ...data });
      },
    };
  }

  function makeQuery(path: string, wheres: any[] = [], orderField?: string, orderDir = 'asc', lim?: number): any {
    return {
      where: (field: string, op: string, value: any) =>
        makeQuery(path, [...wheres, [field, op, value]], orderField, orderDir, lim),
      orderBy: (field: string, dir = 'asc') => makeQuery(path, wheres, field, dir, lim),
      limit: (n: number) => makeQuery(path, wheres, orderField, orderDir, n),
      doc: (id?: string) => makeDocRef(path, id ?? `mock-gen-${++idCounter}`),
      get: async () => {
        let entries = Array.from(coll(path).entries()).filter(([id, d]) =>
          wheres.every((w) => matchesWhere(d, id, w)),
        );
        entries = applyOrderLimit(
          entries,
          orderField ? { field: orderField, direction: orderDir } : undefined,
          lim,
        );
        const docs = entries.map(([id, d]) => ({ id, exists: true, data: () => d }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }

  return {
    collection: (name: string) => makeQuery(name),
  };
}

/* ----------------------------------------------------------- fake adapter */

export interface FakeAdapter {
  setDocCalls: Array<{ path: string; id: string; data: any }>;
  getDoc: (path: string, id: string) => Promise<any>;
  listDocs: (path: string, options?: any) => Promise<any[]>;
  countDocs: (path: string, where?: any[]) => Promise<number>;
  setDoc: (path: string, id: string, data: any) => Promise<any>;
  updateDoc: (path: string, id: string, data: any) => Promise<any>;
  deleteDoc: (path: string, id: string) => Promise<void>;
}

export function makeFakeAdapter(store: Store): FakeAdapter {
  const setDocCalls: FakeAdapter['setDocCalls'] = [];
  return {
    setDocCalls,
    async getDoc(path: string, id: string) {
      const d = store.get(path)?.get(id);
      return d ? { id, ...d } : null;
    },
    async listDocs(path: string, options: any = {}) {
      let entries = Array.from((store.get(path) ?? new Map()).entries()).filter(
        ([id, d]) => (options.where ?? []).every((w: any[]) => matchesWhere(d, id, w)),
      );
      entries = applyOrderLimit(entries, options.orderBy, options.limit);
      return entries.map(([id, d]) => ({ id, ...d }));
    },
    async countDocs(path: string, where: any[] = []) {
      return Array.from((store.get(path) ?? new Map()).entries()).filter(([id, d]) =>
        where.every((w) => matchesWhere(d, id, w)),
      ).length;
    },
    async setDoc(path: string, id: string, data: any) {
      setDocCalls.push({ path, id, data });
      put(store, path, id, data);
      return { id, ...data };
    },
    async updateDoc(path: string, id: string, data: any) {
      const merged = { ...(store.get(path)?.get(id) || {}), ...data };
      put(store, path, id, merged);
      return { id, ...merged };
    },
    async deleteDoc(path: string, id: string) {
      store.get(path)?.delete(id);
    },
  };
}

/** A seam loader module pointing at a fake adapter with the flag forced. */
export function fakeSupaModule(adapter: FakeAdapter, on: boolean) {
  return {
    useSupa: (_surface: string) => on,
    getSupaAdapter: () => adapter,
  };
}
