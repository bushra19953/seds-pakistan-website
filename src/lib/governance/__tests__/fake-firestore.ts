/**
 * Minimal in-memory Firestore stand-in for governance/retention route
 * tests. Supports the surface the routes use: collection get/where,
 * doc get/set/update, add, batch update/commit, orderBy/limit chains.
 * Tracks update/delete calls so tests can assert "no write happened".
 */
export interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

export class FakeFirestore {
  collections = new Map<string, Map<string, Record<string, unknown>>>();
  updateCalls: Array<{ collection: string; id: string }> = [];
  deleteCalls: Array<{ collection: string; id: string }> = [];
  private autoId = 0;

  seed(collection: string, id: string, data: Record<string, unknown>) {
    if (!this.collections.has(collection)) {
      this.collections.set(collection, new Map());
    }
    this.collections.get(collection)?.set(id, { ...data });
  }

  getDoc(collection: string, id: string) {
    return this.collections.get(collection)?.get(id);
  }

  collection(name: string) {
    const self = this;
    const coll = () => {
      if (!self.collections.has(name)) self.collections.set(name, new Map());
      return self.collections.get(name) as Map<string, Record<string, unknown>>;
    };
    const makeSnap = (docs: FakeDoc[]) => ({
      docs: docs.map((d) => ({
        id: d.id,
        exists: true,
        data: () => ({ ...d.data }),
        ref: self.docRef(name, d.id),
      })),
      empty: docs.length === 0,
      size: docs.length,
    });
    const allDocs = () =>
      [...coll().entries()].map(([id, data]) => ({ id, data }));

    // Honest operator evaluation (cron-shelter retention pushdown):
    // date-ish values (Date, epoch ms, ISO strings, Timestamp-likes)
    // compare by millis when either side is a Date; everything else
    // compares directly. '==' keeps the historical strict-equality
    // behaviour for non-date values.
    const toComparable = (v: unknown, other: unknown): unknown => {
      const dateish = (x: unknown) =>
        x instanceof Date ||
        (typeof x === 'object' &&
          x !== null &&
          typeof (x as { toDate?: unknown }).toDate === 'function') ||
        (typeof x === 'object' &&
          x !== null &&
          typeof (x as { seconds?: unknown }).seconds === 'number');
      if (!dateish(v) && !dateish(other)) return v;
      if (v instanceof Date) return v.getTime();
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isNaN(t) ? v : t;
      }
      if (v && typeof v === 'object') {
        const rec = v as { toDate?: () => Date; seconds?: number };
        if (typeof rec.toDate === 'function') return rec.toDate().getTime();
        if (typeof rec.seconds === 'number') return rec.seconds * 1000;
      }
      return v;
    };
    const matches = (dataVal: unknown, op: string, value: unknown): boolean => {
      if (op === 'in') {
        return Array.isArray(value) && value.some((v) => dataVal === v);
      }
      const a = toComparable(dataVal, value);
      const b = toComparable(value, dataVal);
      switch (op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
          return (a as never) < (b as never);
        case '<=':
          return (a as never) <= (b as never);
        case '>':
          return (a as never) > (b as never);
        case '>=':
          return (a as never) >= (b as never);
        default:
          return dataVal === value;
      }
    };

    type Filter = [field: string, op: string, value: unknown];
    const query = (filters: Filter[]) => ({
      where(field: string, op: string, value: unknown) {
        return query([...filters, [field, op, value] as Filter]);
      },
      async get() {
        return makeSnap(
          allDocs().filter((d) =>
            filters.every(([f, op, v]) => matches(d.data[f], op, v)),
          ),
        );
      },
    });

    return {
      doc: (id?: string) => self.docRef(name, id ?? `auto-${++self.autoId}`),
      where: (field: string, op: string, value: unknown) =>
        query([[field, op, value]]),
      async get() {
        return makeSnap(allDocs());
      },
      async add(data: Record<string, unknown>) {
        const id = `auto-${++self.autoId}`;
        coll().set(id, { ...data });
        return { id };
      },
      orderBy: () => ({
        limit: () => ({
          async get() {
            return makeSnap(allDocs());
          },
        }),
      }),
    };
  }

  private docRef(collection: string, id: string) {
    const self = this;
    const coll = () => {
      if (!self.collections.has(collection)) {
        self.collections.set(collection, new Map());
      }
      return self.collections.get(collection) as Map<
        string,
        Record<string, unknown>
      >;
    };
    return {
      id,
      async get() {
        const data = coll().get(id);
        return {
          id,
          exists: data !== undefined,
          data: () => (data ? { ...data } : undefined),
        };
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        if (opts?.merge && coll().has(id)) {
          coll().set(id, { ...coll().get(id), ...data });
        } else {
          coll().set(id, { ...data });
        }
      },
      async update(data: Record<string, unknown>) {
        self.updateCalls.push({ collection, id });
        coll().set(id, { ...coll().get(id), ...data });
      },
      async delete() {
        self.deleteCalls.push({ collection, id });
        coll().delete(id);
      },
    };
  }

  batch() {
    const self = this;
    const ops: Array<() => Promise<void>> = [];
    return {
      update(ref: { update: (d: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) {
        ops.push(() => ref.update(data));
      },
      set(ref: { set: (d: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) {
        ops.push(() => ref.set(data));
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
  }
}
