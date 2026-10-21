/**
 * Minimal in-memory Firestore fake for intake-window route tests.
 *
 * Supports exactly the surface the intake routes and server helpers
 * use: collection().get(), collection().doc(id?).get/set/update, and
 * batch().set/update/commit. Batch ops apply on commit, in order.
 * Not a general Firestore emulator; do not grow it into one.
 */

export interface FakeDocRef {
  id: string;
  /** Collection NAME (renamed from `collection`: the doc ref also
   * carries the Firestore-style collection(sub) method, and the two
   * cannot share a key in one object literal). */
  collectionName: string;
  path: string;
  collection: (sub: string) => {
    doc: (id?: string) => FakeDocRef;
    get: () => Promise<{
      docs: Array<{ id: string; exists: boolean; data: () => Record<string, unknown> }>;
      empty: boolean;
      size: number;
    }>;
  };
  get: () => Promise<{
    id: string;
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
  }>;
  set: (
    data: Record<string, unknown>,
    opts?: { merge?: boolean },
  ) => Promise<void>;
  update: (data: Record<string, unknown>) => Promise<void>;
}

export class FakeDb {
  private store = new Map<string, Map<string, Record<string, unknown>>>();
  private autoId = 0;

  seed(collection: string, id: string, data: Record<string, unknown>): void {
    this.writeDoc(collection, id, data, false);
  }

  docData(
    collection: string,
    id: string,
  ): Record<string, unknown> | undefined {
    return this.store.get(collection)?.get(id);
  }

  allDocs(collection: string): Array<{ id: string; data: Record<string, unknown> }> {
    const col = this.store.get(collection);
    if (!col) return [];
    return [...col.entries()].map(([id, data]) => ({ id, data }));
  }

  private writeDoc(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    merge: boolean,
  ): void {
    let col = this.store.get(collection);
    if (!col) {
      col = new Map();
      this.store.set(collection, col);
    }
    if (merge && col.has(id)) {
      Object.assign(col.get(id) as Record<string, unknown>, data);
    } else {
      col.set(id, { ...data });
    }
  }

  private docRef(collection: string, id: string): FakeDocRef {
    const self = this;
    return {
      id,
      collectionName: collection,
      path: `${collection}/${id}`,
      async get() {
        const data = self.store.get(collection)?.get(id);
        return { id, exists: data !== undefined, data: () => data };
      },
      async set(data, opts) {
        self.writeDoc(collection, id, data, opts?.merge === true);
      },
      async update(data) {
        const current = self.store.get(collection)?.get(id);
        if (!current) throw new Error(`update on missing doc ${collection}/${id}`);
        Object.assign(current, data);
      },
      // Subcollections are stored under the pseudo-collection name
      // "<collection>/<docId>/<sub>", which keeps the two-level store
      // shape while giving history-style subcollections a home.
      collection(sub: string) {
        return self.collectionFor(`${collection}/${id}/${sub}`);
      },
    };
  }

  collection(name: string) {
    return this.collectionFor(name);
  }

  private collectionFor(name: string) {
    const self = this;
    const base = {
      doc(id?: string) {
        return self.docRef(name, id ?? `auto-${++self.autoId}`);
      },
      async get() {
        return self.queryGet(name, [], null, null);
      },
      where(field: string, op: string, value: unknown) {
        return self.query(name, [{ field, op, value }], null, null);
      },
      orderBy(field: string, dir: string = 'asc') {
        return self.query(name, [], { field, dir }, null);
      },
      limit(n: number) {
        return self.query(name, [], null, n);
      },
    };
    return base;
  }

  private query(
    name: string,
    filters: Array<{ field: string; op: string; value: unknown }>,
    order: { field: string; dir: string } | null,
    limitN: number | null,
  ) {
    const self = this;
    return {
      where(field: string, op: string, value: unknown) {
        return self.query(name, [...filters, { field, op, value }], order, limitN);
      },
      orderBy(field: string, dir: string = 'asc') {
        return self.query(name, filters, { field, dir }, limitN);
      },
      limit(n: number) {
        return self.query(name, filters, order, n);
      },
      async get() {
        return self.queryGet(name, filters, order, limitN);
      },
    };
  }

  private queryGet(
    name: string,
    filters: Array<{ field: string; op: string; value: unknown }>,
    order: { field: string; dir: string } | null,
    limitN: number | null,
  ) {
    const col = this.store.get(name);
    let entries = col ? [...col.entries()] : [];
    const resolvePath = (data: Record<string, unknown>, path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>(
          (acc, key) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string, unknown>)[key]
              : undefined,
          data,
        );
    for (const f of filters) {
      if (f.op !== '==') throw new Error(`FakeDb: unsupported op ${f.op}`);
      entries = entries.filter(([, data]) => resolvePath(data, f.field) === f.value);
    }
    if (order) {
      const dirMul = order.dir === 'desc' ? -1 : 1;
      entries.sort((a, b) => {
        const av = resolvePath(a[1], order.field);
        const bv = resolvePath(b[1], order.field);
        const aMs =
          av && typeof av === 'object' && typeof (av as { toMillis?: unknown }).toMillis === 'function'
            ? (av as { toMillis: () => number }).toMillis()
            : (av as number);
        const bMs =
          bv && typeof bv === 'object' && typeof (bv as { toMillis?: unknown }).toMillis === 'function'
            ? (bv as { toMillis: () => number }).toMillis()
            : (bv as number);
        return ((aMs ?? 0) > (bMs ?? 0) ? 1 : (aMs ?? 0) < (bMs ?? 0) ? -1 : 0) * dirMul;
      });
    }
    if (limitN !== null) entries = entries.slice(0, limitN);
    const docs = entries.map(([id, data]) => ({
      id,
      exists: true,
      data: () => data,
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  batch() {
    const self = this;
    const ops: Array<() => void> = [];
    return {
      set(
        ref: FakeDocRef,
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) {
        ops.push(() =>
          self.writeDoc(ref.collectionName, ref.id, data, opts?.merge === true),
        );
      },
      update(ref: FakeDocRef, data: Record<string, unknown>) {
        ops.push(() => {
          const current = self.store.get(ref.collectionName)?.get(ref.id);
          if (!current) {
            throw new Error(`batch update on missing doc ${ref.path}`);
          }
          Object.assign(current, data);
        });
      },
      async commit() {
        for (const op of ops) op();
      },
    };
  }
}
