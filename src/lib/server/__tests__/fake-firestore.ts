// In-memory fake Firestore for governance service tests.
// Supports the exact surface the Phase 2 services use: collection/doc
// get-set-update, subcollections, where/orderBy/limit/startAfter queries,
// batches, and serialized transactions (so the consent counter's
// read-modify-write inside runTransaction behaves like production).
// NOT a test file (no .test. suffix): imported by suites that need it.

type DocData = Record<string, any>;

// Deep clone that rebuilds Dates with this realm's Date constructor.
// structuredClone crosses realms under Jest, which breaks `instanceof
// Date` checks in the services under test.
function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((v) => clone(v)) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clone(v);
    }
    return out as T;
  }
  return value;
}

function compareValues(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function matches(data: DocData, field: string, op: string, value: any): boolean {
  const actual = data[field];
  switch (op) {
    case '==':
      return actual === value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case '>=':
      return compareValues(actual, value) >= 0;
    case '<=':
      return compareValues(actual, value) <= 0;
    case '>':
      return compareValues(actual, value) > 0;
    case '<':
      return compareValues(actual, value) < 0;
    default:
      throw new Error(`fake-firestore: unsupported op ${op}`);
  }
}

export class FakeDocRef {
  constructor(
    public db: FakeDb,
    public collectionPath: string,
    public id: string,
  ) {}
  get path() {
    return `${this.collectionPath}/${this.id}`;
  }
  collection(name: string) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }
  async get() {
    return this.db._snapshot(this.collectionPath, this.id, this);
  }
  async set(data: DocData, opts?: { merge?: boolean }) {
    this.db._setDoc(this.collectionPath, this.id, data, opts?.merge === true);
  }
  async update(data: DocData) {
    this.db._updateDoc(this.collectionPath, this.id, data);
  }
}

class FakeQuery {
  constructor(
    protected db: FakeDb,
    protected collectionPath: string,
    protected filters: Array<[string, string, any]> = [],
    protected orders: Array<[string, 'asc' | 'desc']> = [],
    protected limitN: number | null = null,
    protected startAfterId: string | null = null,
  ) {}
  where(field: string, op: string, value: any) {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      [...this.filters, [field, op, value]],
      this.orders,
      this.limitN,
      this.startAfterId,
    );
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.filters,
      [...this.orders, [field, dir]],
      this.limitN,
      this.startAfterId,
    );
  }
  limit(n: number) {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.filters,
      this.orders,
      n,
      this.startAfterId,
    );
  }
  startAfter(snap: any) {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.filters,
      this.orders,
      this.limitN,
      snap?.id ?? null,
    );
  }
  async get() {
    let rows = this.db._docsIn(this.collectionPath);
    for (const [field, op, value] of this.filters) {
      rows = rows.filter((r) => matches(r.data, field, op, value));
    }
    for (const [field, dir] of [...this.orders].reverse()) {
      rows = [...rows].sort((x, y) => {
        const c = compareValues(x.data[field], y.data[field]);
        return dir === 'desc' ? -c : c;
      });
    }
    if (this.startAfterId) {
      const idx = rows.findIndex((r) => r.id === this.startAfterId);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    const docs = rows.map((r) => ({
      id: r.id,
      exists: true,
      data: () => clone(r.data),
      ref: new FakeDocRef(this.db, this.collectionPath, r.id),
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

export class FakeCollectionRef extends FakeQuery {
  doc(id?: string) {
    const docId = id ?? this.db._nextId();
    return new FakeDocRef(this.db, this.collectionPath, docId);
  }
}

export class FakeDb {
  private store = new Map<string, Map<string, DocData>>();
  private idCounter = 0;
  private txChain: Promise<unknown> = Promise.resolve();

  _nextId() {
    this.idCounter += 1;
    return `auto-${this.idCounter}`;
  }
  _docsIn(collectionPath: string) {
    const col = this.store.get(collectionPath);
    if (!col) return [] as Array<{ id: string; data: DocData }>;
    return [...col.entries()].map(([id, data]) => ({ id, data }));
  }
  _getDoc(collectionPath: string, id: string): DocData | undefined {
    return this.store.get(collectionPath)?.get(id);
  }
  _snapshot(collectionPath: string, id: string, ref: FakeDocRef) {
    const data = this._getDoc(collectionPath, id);
    return {
      id,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : clone(data)),
      ref,
    };
  }
  _setDoc(collectionPath: string, id: string, data: DocData, merge: boolean) {
    let col = this.store.get(collectionPath);
    if (!col) {
      col = new Map();
      this.store.set(collectionPath, col);
    }
    if (merge && col.has(id)) {
      col.set(id, { ...col.get(id), ...clone(data) });
    } else {
      col.set(id, clone(data));
    }
  }
  _updateDoc(collectionPath: string, id: string, data: DocData) {
    const existing = this._getDoc(collectionPath, id);
    if (existing === undefined) {
      throw new Error(`fake-firestore: update on missing doc ${collectionPath}/${id}`);
    }
    this._setDoc(collectionPath, id, { ...existing, ...clone(data) }, false);
  }

  collection(path: string) {
    return new FakeCollectionRef(this, path);
  }

  batch() {
    const ops: Array<() => void> = [];
    const db = this;
    return {
      set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) {
        ops.push(() => db._setDoc(ref.collectionPath, ref.id, data, opts?.merge === true));
        return this;
      },
      update(ref: FakeDocRef, data: DocData) {
        ops.push(() => db._updateDoc(ref.collectionPath, ref.id, data));
        return this;
      },
      async commit() {
        for (const op of ops) op();
      },
    };
  }

  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = this.txChain.then(() => {
      const db = this;
      const tx = {
        get: (ref: FakeDocRef) => ref.get(),
        set: (ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) =>
          db._setDoc(ref.collectionPath, ref.id, data, opts?.merge === true),
        update: (ref: FakeDocRef, data: DocData) =>
          db._updateDoc(ref.collectionPath, ref.id, data),
      };
      return fn(tx);
    });
    this.txChain = run.catch(() => undefined);
    return run;
  }

  // Test helpers ------------------------------------------------------------
  seed(collectionPath: string, id: string, data: DocData) {
    this._setDoc(collectionPath, id, data, false);
  }
  read(collectionPath: string, id: string): DocData | undefined {
    const data = this._getDoc(collectionPath, id);
    return data === undefined ? undefined : clone(data);
  }
  all(collectionPath: string) {
    return this._docsIn(collectionPath).map((r) => ({ id: r.id, data: clone(r.data) }));
  }
}

export function createFakeDb(): FakeDb {
  return new FakeDb();
}
