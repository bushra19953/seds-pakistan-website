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
  collection: string;
  path: string;
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
      collection,
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
    };
  }

  collection(name: string) {
    const self = this;
    return {
      doc(id?: string) {
        return self.docRef(name, id ?? `auto-${++self.autoId}`);
      },
      async get() {
        const col = self.store.get(name);
        const docs = col
          ? [...col.entries()].map(([id, data]) => ({
              id,
              exists: true,
              data: () => data,
            }))
          : [];
        return { docs };
      },
    };
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
          self.writeDoc(ref.collection, ref.id, data, opts?.merge === true),
        );
      },
      update(ref: FakeDocRef, data: Record<string, unknown>) {
        ops.push(() => {
          const current = self.store.get(ref.collection)?.get(ref.id);
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
