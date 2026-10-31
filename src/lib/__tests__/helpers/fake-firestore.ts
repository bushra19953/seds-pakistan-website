/**
 * Minimal in-memory Firestore fake for Phase 1 server-module tests.
 * Implements only the surface the role write path and reconciliation use:
 * collection/doc get-set-delete, where(==) + array-contains + limit,
 * batches, and FieldValue.delete/serverTimestamp semantics on merge-set.
 * Extended for the vendor shop helpers (PLAN-ga Section 8.3): doc
 * create() failing on an existing doc, and orderBy on queries.
 */

type DocData = Record<string, unknown>;

function isDeleteSentinel(v: unknown): boolean {
  // firebase-admin v13: FieldValue.delete() is a DeleteTransform instance.
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { constructor?: { name?: string } }).constructor?.name === 'DeleteTransform'
  );
}

export class FakeDocRef {
  constructor(
    public readonly store: Map<string, Map<string, DocData>>,
    public readonly collectionName: string,
    public readonly id: string,
  ) {}

  async get(): Promise<{
    exists: boolean;
    id: string;
    data(): DocData | undefined;
    ref: FakeDocRef;
  }> {
    const data = this.store.get(this.collectionName)?.get(this.id);
    return {
      exists: data !== undefined,
      id: this.id,
      data: () => (data ? { ...data } : undefined),
      ref: this,
    };
  }

  async set(data: DocData, opts?: { merge?: boolean }): Promise<void> {
    applySet(this.store, this.collectionName, this.id, data, opts?.merge === true);
  }

  async create(data: DocData): Promise<void> {
    if (this.store.get(this.collectionName)?.has(this.id)) {
      const err = new Error(
        `ALREADY_EXISTS: Document already exists: ${this.collectionName}/${this.id}`,
      ) as Error & { code?: string };
      err.code = 'already-exists';
      throw err;
    }
    applySet(this.store, this.collectionName, this.id, data, false);
  }

  async update(data: DocData): Promise<void> {
    applySet(this.store, this.collectionName, this.id, data, true);
  }

  async delete(): Promise<void> {
    this.store.get(this.collectionName)?.delete(this.id);
  }
}

function applySet(
  store: Map<string, Map<string, DocData>>,
  collectionName: string,
  id: string,
  data: DocData,
  merge: boolean,
): void {
  if (!store.has(collectionName)) store.set(collectionName, new Map());
  const col = store.get(collectionName)!;
  const next: DocData = merge ? { ...(col.get(id) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (isDeleteSentinel(v)) delete next[k];
    else next[k] = v;
  }
  col.set(id, next);
}

function compareForOrder(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'string' && typeof bv === 'string') return av < bv ? -1 : 1;
  // Non-comparable values (e.g. FieldValue sentinels) keep insertion order.
  return 0;
}

class FakeQuery {
  private filters: Array<{ field: string; op: string; value: unknown }> = [];
  private orders: Array<{ field: string; direction: 'asc' | 'desc' }> = [];
  private limitN: number | null = null;
  constructor(
    private readonly store: Map<string, Map<string, DocData>>,
    private readonly collectionName: string,
  ) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    this.filters.push({ field, op, value });
    return this;
  }
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    this.orders.push({ field, direction });
    return this;
  }
  limit(n: number): FakeQuery {
    this.limitN = n;
    return this;
  }
  async get(): Promise<{
    empty: boolean;
    size: number;
    docs: Array<{ id: string; data(): DocData; ref: FakeDocRef }>;
    forEach(cb: (doc: { id: string; data(): DocData; ref: FakeDocRef }) => void): void;
  }> {
    const col = this.store.get(this.collectionName) ?? new Map<string, DocData>();
    let docs = [...col.entries()].map(([id, data]) => ({ id, data: { ...data } }));
    for (const f of this.filters) {
      docs = docs.filter((d) => {
        const v = d.data[f.field];
        if (f.op === '==') return v === f.value;
        if (f.op === 'array-contains') return Array.isArray(v) && v.includes(f.value);
        if (f.op === 'in') return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
        return false;
      });
    }
    for (const o of [...this.orders].reverse()) {
      docs = [...docs].sort((x, y) => {
        const c = compareForOrder(x.data[o.field], y.data[o.field]);
        return o.direction === 'desc' ? -c : c;
      });
    }
    if (this.limitN !== null) docs = docs.slice(0, this.limitN);
    const mapped = docs.map((d) => ({
      id: d.id,
      data: () => d.data,
      ref: new FakeDocRef(this.store, this.collectionName, d.id),
    }));
    return {
      empty: mapped.length === 0,
      size: mapped.length,
      docs: mapped,
      forEach: (cb) => mapped.forEach(cb),
    };
  }
}

class FakeCollection extends FakeQuery {
  private counter = 0;
  constructor(
    store: Map<string, Map<string, DocData>>,
    private readonly name: string,
  ) {
    super(store, name);
    this.storeRef = store;
  }
  private readonly storeRef: Map<string, Map<string, DocData>>;
  doc(id?: string): FakeDocRef {
    const docId = id ?? `auto-${this.name}-${++this.counter}-${Math.random().toString(36).slice(2, 8)}`;
    return new FakeDocRef(this.storeRef, this.name, docId);
  }
  async add(data: DocData): Promise<FakeDocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeBatch {
  private ops: Array<() => Promise<void>> = [];
  constructor(private readonly failOnCommit: boolean) {}
  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }): this {
    this.ops.push(() => ref.set(data, opts));
    return this;
  }
  update(ref: FakeDocRef, data: DocData): this {
    this.ops.push(() => ref.update(data));
    return this;
  }
  delete(ref: FakeDocRef): this {
    this.ops.push(() => ref.delete());
    return this;
  }
  async commit(): Promise<void> {
    if (this.failOnCommit) throw new Error('fake commit failure');
    for (const op of this.ops) await op();
  }
}

export class FakeFirestore {
  readonly store = new Map<string, Map<string, DocData>>();
  failCommits = false;
  collection(name: string): FakeCollection {
    return new FakeCollection(this.store, name);
  }
  batch(): FakeBatch {
    return new FakeBatch(this.failCommits);
  }
  seed(collectionName: string, id: string, data: DocData): void {
    if (!this.store.has(collectionName)) this.store.set(collectionName, new Map());
    this.store.get(collectionName)!.set(id, { ...data });
  }
  read(collectionName: string, id: string): DocData | undefined {
    const data = this.store.get(collectionName)?.get(id);
    return data ? { ...data } : undefined;
  }
  all(collectionName: string): Array<{ id: string; data: DocData }> {
    const col = this.store.get(collectionName);
    if (!col) return [];
    return [...col.entries()].map(([id, data]) => ({ id, data: { ...data } }));
  }
  asDb(): never {
    return this as unknown as never;
  }
}
