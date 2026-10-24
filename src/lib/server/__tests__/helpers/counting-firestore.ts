/**
 * Counting Firestore harness (Read-Burn Fix Program, plan §5).
 *
 * Wraps the repo's existing FakeFirestore
 * (src/lib/__tests__/helpers/fake-firestore.ts) - same backing store,
 * same seed/read surface - and adds:
 *   - per-document get() counters keyed `collection/docId`
 *   - per-collection query get() counters (calls + docs returned)
 *   - a failure mode where a chosen collection's doc gets throw a
 *     RESOURCE_EXHAUSTED-coded error (quota-parity tests, T-A5)
 *   - the wider surface the route handlers under test use:
 *     where/orderBy/limit/startAfter/select, add, batch, runTransaction
 *
 * Batches and transactions pass through to real writes against the
 * same store (refs are unwrapped), so write-path tests exercise the
 * real production code, per plan §5.
 */
import { FakeFirestore, FakeDocRef } from '../../../__tests__/helpers/fake-firestore';

type DocData = Record<string, unknown>;

function isDeleteSentinel(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { constructor?: { name?: string } }).constructor?.name === 'DeleteTransform'
  );
}

function applyData(
  existing: DocData | undefined,
  data: DocData,
  merge: boolean,
): DocData {
  const next: DocData = merge && existing ? { ...existing } : {};
  for (const [k, v] of Object.entries(data)) {
    if (isDeleteSentinel(v)) delete next[k];
    else next[k] = v;
  }
  return next;
}

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

function matchesFilter(id: string, data: DocData, f: Filter): boolean {
  const v = f.field === '__name__' ? id : data[f.field];
  switch (f.op) {
    case '==': return v === f.value;
    case '!=': return v !== f.value;
    case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
    case 'array-contains': return Array.isArray(v) && (v as unknown[]).includes(f.value);
    case '>': return (v as never) > (f.value as never);
    case '>=': return (v as never) >= (f.value as never);
    case '<': return (v as never) < (f.value as never);
    case '<=': return (v as never) <= (f.value as never);
    default: return false;
  }
}

export class CountingDocRef {
  constructor(
    private readonly owner: CountingFirestore,
    public readonly collectionName: string,
    public readonly id: string,
  ) {}

  get raw(): FakeDocRef {
    return new FakeDocRef(this.owner.fake.store, this.collectionName, this.id);
  }

  get path(): string {
    return `${this.collectionName}/${this.id}`;
  }

  async get(): Promise<{ exists: boolean; id: string; data(): DocData | undefined; ref: CountingDocRef }> {
    this.owner.noteDocGet(this.collectionName, this.id);
    const snap = await this.raw.get();
    return { exists: snap.exists, id: snap.id, data: snap.data, ref: this };
  }

  async set(data: DocData, opts?: { merge?: boolean }): Promise<void> {
    const col = this.owner.colMap(this.collectionName);
    col.set(this.id, applyData(col.get(this.id), data, opts?.merge === true));
  }

  async update(data: DocData): Promise<void> {
    const col = this.owner.colMap(this.collectionName);
    if (!col.has(this.id)) throw new Error(`counting-firestore: update on missing doc ${this.path}`);
    col.set(this.id, applyData(col.get(this.id), data, true));
  }

  async delete(): Promise<void> {
    this.owner.fake.store.get(this.collectionName)?.delete(this.id);
  }

  collection(name: string): CountingCollection {
    return new CountingCollection(this.owner, `${this.collectionName}/${this.id}/${name}`);
  }
}

export class CountingQuery {
  protected filters: Filter[] = [];
  protected orderField: string | null = null;
  protected orderDir: 'asc' | 'desc' = 'asc';
  protected limitN: number | null = null;
  protected startAfterId: string | null = null;
  protected selectFields: string[] | null = null;

  constructor(
    protected readonly owner: CountingFirestore,
    public readonly collectionName: string,
  ) {}

  where(field: string, op: string, value: unknown): this {
    this.filters.push({ field, op, value });
    return this;
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): this {
    this.orderField = field;
    this.orderDir = dir;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  startAfter(id: string): this {
    this.startAfterId = id;
    return this;
  }
  select(...fields: string[]): this {
    this.selectFields = fields;
    return this;
  }

  async get(): Promise<{
    empty: boolean;
    size: number;
    docs: Array<{ id: string; exists: boolean; data(): DocData; ref: CountingDocRef }>;
    forEach(cb: (doc: { id: string; data(): DocData; ref: CountingDocRef }) => void): void;
  }> {
    const col = this.owner.fake.store.get(this.collectionName) ?? new Map<string, DocData>();
    let entries = [...col.entries()].map(([id, data]) => ({ id, data: { ...data } }));
    for (const f of this.filters) entries = entries.filter((e) => matchesFilter(e.id, e.data, f));
    if (this.orderField) {
      const field = this.orderField;
      const dir = this.orderDir === 'desc' ? -1 : 1;
      entries.sort((a, b) => {
        const av = field === '__name__' ? a.id : a.data[field];
        const bv = field === '__name__' ? b.id : b.data[field];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        return (av < bv ? -1 : 1) * dir;
      });
    }
    if (this.startAfterId) {
      const idx = entries.findIndex((e) => e.id === this.startAfterId);
      if (idx >= 0) entries = entries.slice(idx + 1);
    }
    if (this.limitN !== null) entries = entries.slice(0, this.limitN);
    this.owner.noteQueryGet(this.collectionName, entries.length);
    const selectFields = this.selectFields;
    const docs = entries.map((e) => ({
      id: e.id,
      exists: true,
      data: () => {
        if (!selectFields) return e.data;
        const projected: DocData = {};
        for (const f of selectFields) if (f in e.data) projected[f] = e.data[f];
        return projected;
      },
      ref: new CountingDocRef(this.owner, this.collectionName, e.id),
    }));
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
      forEach: (cb) => docs.forEach(cb),
    };
  }
}

export class CountingCollection extends CountingQuery {
  private counter = 0;
  doc(id?: string): CountingDocRef {
    const docId = id ?? `auto-${++this.counter}-${Math.random().toString(36).slice(2, 8)}`;
    return new CountingDocRef(this.owner, this.collectionName, docId);
  }
  async add(data: DocData): Promise<CountingDocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class CountingBatch {
  private ops: Array<() => Promise<void>> = [];
  constructor(private readonly owner: CountingFirestore) {}
  private rawOf(ref: CountingDocRef): FakeDocRef {
    return ref.raw;
  }
  set(ref: CountingDocRef, data: DocData, opts?: { merge?: boolean }): this {
    this.ops.push(async () => {
      const col = this.owner.colMap(ref.collectionName);
      col.set(ref.id, applyData(col.get(ref.id), data, opts?.merge === true));
    });
    return this;
  }
  update(ref: CountingDocRef, data: DocData): this {
    this.ops.push(() => ref.update(data));
    return this;
  }
  delete(ref: CountingDocRef): this {
    this.ops.push(() => ref.delete());
    return this;
  }
  async commit(): Promise<void> {
    void this.rawOf;
    for (const op of this.ops) await op();
  }
}

export class CountingFirestore {
  readonly fake: FakeFirestore;
  private docGets = new Map<string, number>();
  private queryCalls = new Map<string, number>();
  private queryDocs = new Map<string, number>();
  private throwCollection: string | null = null;
  private throwError: Error | null = null;

  constructor(fake: FakeFirestore = new FakeFirestore()) {
    this.fake = fake;
  }

  // -- FakeFirestore-compatible seeding/inspection -------------------
  seed(collectionName: string, id: string, data: DocData): void {
    this.fake.seed(collectionName, id, data);
  }
  read(collectionName: string, id: string): DocData | undefined {
    return this.fake.read(collectionName, id);
  }
  all(collectionName: string): Array<{ id: string; data: DocData }> {
    return this.fake.all(collectionName);
  }

  colMap(collectionName: string): Map<string, DocData> {
    if (!this.fake.store.has(collectionName)) this.fake.store.set(collectionName, new Map());
    return this.fake.store.get(collectionName)!;
  }

  // -- Counting --------------------------------------------------------
  noteDocGet(collectionName: string, id: string): void {
    if (this.throwCollection === collectionName && this.throwError) throw this.throwError;
    const key = `${collectionName}/${id}`;
    this.docGets.set(key, (this.docGets.get(key) ?? 0) + 1);
  }
  noteQueryGet(collectionName: string, docsReturned: number): void {
    if (this.throwCollection === collectionName && this.throwError) throw this.throwError;
    this.queryCalls.set(collectionName, (this.queryCalls.get(collectionName) ?? 0) + 1);
    this.queryDocs.set(collectionName, (this.queryDocs.get(collectionName) ?? 0) + docsReturned);
  }
  /** Make doc/query gets on `collection` throw `error` (null clears). */
  setThrow(collection: string | null, error: Error | null): void {
    this.throwCollection = collection;
    this.throwError = error;
  }
  resetCounts(): void {
    this.docGets.clear();
    this.queryCalls.clear();
    this.queryDocs.clear();
  }
  docGetCount(collection: string, id?: string): number {
    if (id !== undefined) return this.docGets.get(`${collection}/${id}`) ?? 0;
    let total = 0;
    for (const [key, n] of this.docGets) if (key.startsWith(`${collection}/`)) total += n;
    return total;
  }
  queryCallCount(collection: string): number {
    return this.queryCalls.get(collection) ?? 0;
  }
  counts(): { docGets: Record<string, number>; queryCalls: Record<string, number> } {
    return {
      docGets: Object.fromEntries(this.docGets),
      queryCalls: Object.fromEntries(this.queryCalls),
    };
  }
  /**
   * Identity+permission doc-get total (plan §2.6 counting method):
   * doc gets on roles / roleDefinitions / permissions, plus users doc
   * gets for the uids in `identityUids` (users gets for OTHER uids are
   * business reads - submitter profiles etc. - and excluded).
   */
  identityPermissionDocGets(identityUids: string[]): number {
    let total = 0;
    total += this.docGetCount('roles');
    total += this.docGetCount('roleDefinitions');
    total += this.docGetCount('permissions');
    for (const uid of identityUids) total += this.docGetCount('users', uid);
    return total;
  }

  // -- Firestore surface ------------------------------------------------
  collection(name: string): CountingCollection {
    return new CountingCollection(this, name);
  }
  batch(): CountingBatch {
    return new CountingBatch(this);
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const buffered: Array<() => Promise<void>> = [];
    const tx = {
      get: (ref: CountingDocRef) => ref.get(),
      set: (ref: CountingDocRef, data: DocData, opts?: { merge?: boolean }) => {
        buffered.push(() => ref.set(data, opts));
      },
      update: (ref: CountingDocRef, data: DocData) => {
        buffered.push(() => ref.update(data));
      },
      delete: (ref: CountingDocRef) => {
        buffered.push(() => ref.delete());
      },
    };
    const result = await fn(tx);
    for (const op of buffered) await op();
    return result;
  }
  asDb(): never {
    return this as unknown as never;
  }
}

export function resourceExhaustedError(): Error & { code: string } {
  const err = new Error('Quota exceeded.') as Error & { code: string };
  err.code = 'RESOURCE_EXHAUSTED';
  return err;
}
