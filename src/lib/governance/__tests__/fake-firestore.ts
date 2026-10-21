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

    const query = (filters: Array<[string, unknown]>) => ({
      where(field: string, _op: string, value: unknown) {
        return query([...filters, [field, value]]);
      },
      async get() {
        return makeSnap(
          allDocs().filter((d) =>
            filters.every(([f, v]) => d.data[f] === v),
          ),
        );
      },
    });

    return {
      doc: (id?: string) => self.docRef(name, id ?? `auto-${++self.autoId}`),
      where: (field: string, op: string, value: unknown) =>
        query([[field, value]]),
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
