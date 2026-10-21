/**
 * In-memory Firestore fake for elections server tests.
 *
 * Shared by the Phase 3 Workstream B server suites (roll, nominations,
 * ballot, declare, agm). It implements exactly the Firestore subset the
 * elections server modules are allowed to use:
 *   collection / doc / get / set / update / delete / add
 *   where ('==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains')
 *   orderBy / limit / runTransaction / batch / collectionGroup
 *   FieldValue.serverTimestamp() and FieldValue.increment(n)
 *   admin.firestore.Timestamp (FakeTimestamp)
 *
 * Usage in a suite:
 *   jest.mock('firebase-admin', () =>
 *     require('../helpers/fake-firestore').fakeFirebaseAdminModule());
 *   import { createFakeDb } from '../helpers/fake-firestore';
 *   const db = createFakeDb();
 *
 * A module-level clock is shared by the fake admin module and every fake
 * db in the same test file, so tests can pin time with setFakeNow().
 */

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

let fakeNowMillis: number | null = null;

export function setFakeNow(millis: number | null): void {
  fakeNowMillis = millis;
}

export function fakeNow(): number {
  return fakeNowMillis !== null ? fakeNowMillis : Date.now();
}

// ---------------------------------------------------------------------------
// FakeTimestamp
// ---------------------------------------------------------------------------

export class FakeTimestamp {
  readonly seconds: number;
  readonly nanoseconds: number;

  constructor(seconds: number, nanoseconds: number = 0) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  static now(): FakeTimestamp {
    return FakeTimestamp.fromMillis(fakeNow());
  }

  static fromMillis(millis: number): FakeTimestamp {
    const seconds = Math.floor(millis / 1000);
    const nanoseconds = Math.floor((millis - seconds * 1000) * 1e6);
    return new FakeTimestamp(seconds, nanoseconds);
  }

  static fromDate(date: Date): FakeTimestamp {
    return FakeTimestamp.fromMillis(date.getTime());
  }

  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }

  toDate(): Date {
    return new Date(this.toMillis());
  }

  isEqual(other: FakeTimestamp): boolean {
    return (
      other instanceof FakeTimestamp &&
      this.seconds === other.seconds &&
      this.nanoseconds === other.nanoseconds
    );
  }

  toJSON(): { seconds: number; nanoseconds: number } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }
}

// ---------------------------------------------------------------------------
// FieldValue sentinels
// ---------------------------------------------------------------------------

class ServerTimestampSentinel {
  readonly __fakeFieldValue = 'serverTimestamp';
}

class IncrementSentinel {
  readonly __fakeFieldValue = 'increment';
  constructor(readonly n: number) {}
}

function isSentinel(v: unknown): v is ServerTimestampSentinel | IncrementSentinel {
  return (
    typeof v === 'object' &&
    v !== null &&
    '__fakeFieldValue' in (v as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  if (value instanceof FakeTimestamp) {
    return new FakeTimestamp(value.seconds, value.nanoseconds) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepClone(v);
    }
    return out as T;
  }
  return value;
}

/** Resolve FieldValue sentinels in a write payload against the old value. */
function resolveSentinels(value: unknown, oldValue: unknown): unknown {
  if (value instanceof ServerTimestampSentinel) {
    return FakeTimestamp.now();
  }
  if (value instanceof IncrementSentinel) {
    const base = typeof oldValue === 'number' ? oldValue : 0;
    return base + value.n;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      resolveSentinels(v, Array.isArray(oldValue) ? oldValue[i] : undefined),
    );
  }
  if (typeof value === 'object' && value !== null && !(value instanceof FakeTimestamp) && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    const oldObj =
      typeof oldValue === 'object' && oldValue !== null
        ? (oldValue as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveSentinels(v, oldObj[k]);
    }
    return out;
  }
  return value;
}

function toComparable(v: unknown): number | string | boolean | null {
  if (v instanceof FakeTimestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

function compareValues(a: unknown, b: unknown): number {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (ca === cb) return 0;
  if (ca === null) return -1;
  if (cb === null) return 1;
  if (typeof ca === 'number' && typeof cb === 'number') return ca - cb;
  return String(ca) < String(cb) ? -1 : 1;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof FakeTimestamp && b instanceof FakeTimestamp) {
    return a.toMillis() === b.toMillis();
  }
  return a === b;
}

function getField(data: Record<string, unknown>, field: string): unknown {
  // Supports dotted paths one level deep and plain fields.
  if (field in data) return data[field];
  const parts = field.split('.');
  let cur: unknown = data;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

interface OrderClause {
  field: string;
  dir: 'asc' | 'desc';
}

class FakeDocSnapshot {
  constructor(
    readonly id: string,
    readonly ref: FakeDocRef,
    private readonly raw: Record<string, unknown> | undefined,
  ) {}

  get exists(): boolean {
    return this.raw !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.raw === undefined ? undefined : deepClone(this.raw);
  }
}

class FakeQuerySnapshot {
  constructor(readonly docs: FakeDocSnapshot[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }

  forEach(cb: (doc: FakeDocSnapshot) => void): void {
    this.docs.forEach(cb);
  }
}

class FakeQuery {
  protected wheres: WhereClause[] = [];
  protected orders: OrderClause[] = [];
  protected limitN: number | null = null;

  constructor(
    protected readonly store: Map<string, Record<string, unknown>>,
    protected readonly collectionPath: string,
    protected readonly db: FakeFirestore,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    const q = this.clone();
    q.wheres.push({ field, op, value });
    return q;
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    const q = this.clone();
    q.orders.push({ field, dir });
    return q;
  }

  limit(n: number): FakeQuery {
    const q = this.clone();
    q.limitN = n;
    return q;
  }

  protected clone(): FakeQuery {
    const q = new FakeQuery(this.store, this.collectionPath, this.db);
    q.wheres = [...this.wheres];
    q.orders = [...this.orders];
    q.limitN = this.limitN;
    return q;
  }

  protected matchingDocs(): Array<[string, Record<string, unknown>]> {
    const prefix = this.collectionPath + '/';
    const out: Array<[string, Record<string, unknown>]> = [];
    for (const [path, data] of this.store.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes('/')) continue; // direct children only
      if (this.matches(data)) out.push([path, data]);
    }
    out.sort((a, b) => {
      for (const o of this.orders) {
        const cmp = compareValues(getField(a[1], o.field), getField(b[1], o.field));
        if (cmp !== 0) return o.dir === 'desc' ? -cmp : cmp;
      }
      return a[0] < b[0] ? -1 : 1;
    });
    return this.limitN !== null ? out.slice(0, this.limitN) : out;
  }

  protected matches(data: Record<string, unknown>): boolean {
    for (const w of this.wheres) {
      const actual = getField(data, w.field);
      switch (w.op) {
        case '==':
          if (!valuesEqual(actual, w.value)) return false;
          break;
        case '!=':
          if (valuesEqual(actual, w.value)) return false;
          break;
        case '<':
          if (!(compareValues(actual, w.value) < 0)) return false;
          break;
        case '<=':
          if (!(compareValues(actual, w.value) <= 0)) return false;
          break;
        case '>':
          if (!(compareValues(actual, w.value) > 0)) return false;
          break;
        case '>=':
          if (!(compareValues(actual, w.value) >= 0)) return false;
          break;
        case 'in':
          if (!Array.isArray(w.value) || !w.value.some((v) => valuesEqual(actual, v))) return false;
          break;
        case 'array-contains':
          if (!Array.isArray(actual) || !actual.some((v) => valuesEqual(v, w.value))) return false;
          break;
        default:
          throw new Error(`fake-firestore: unsupported where op ${w.op}`);
      }
    }
    return true;
  }

  async get(): Promise<FakeQuerySnapshot> {
    const docs = this.matchingDocs().map(([path, data]) => {
      const ref = this.db.doc(path) as unknown as FakeDocRef;
      return new FakeDocSnapshot(ref.id, ref, data);
    });
    return new FakeQuerySnapshot(docs);
  }
}

class FakeCollectionRef extends FakeQuery {
  constructor(store: Map<string, Record<string, unknown>>, path: string, db: FakeFirestore) {
    super(store, path, db);
  }

  get id(): string {
    return this.collectionPath.split('/').pop() as string;
  }

  get path(): string {
    return this.collectionPath;
  }

  doc(id?: string): FakeDocRef {
    const docId = id ?? this.db._nextAutoId();
    return new FakeDocRef(this.store, `${this.collectionPath}/${docId}`, this.db);
  }

  async add(data: Record<string, unknown>): Promise<FakeDocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeDocRef {
  constructor(
    protected readonly store: Map<string, Record<string, unknown>>,
    readonly path: string,
    protected readonly db: FakeFirestore,
  ) {}

  get id(): string {
    return this.path.split('/').pop() as string;
  }

  collection(subPath: string): FakeCollectionRef {
    return new FakeCollectionRef(this.store, `${this.path}/${subPath}`, this.db);
  }

  async get(): Promise<FakeDocSnapshot> {
    const raw = this.store.get(this.path);
    return new FakeDocSnapshot(this.id, this, raw);
  }

  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    const old = this.store.get(this.path);
    const resolved = resolveSentinels(deepClone(data), old) as Record<string, unknown>;
    if (opts?.merge && old) {
      this.store.set(this.path, { ...deepClone(old), ...resolved });
    } else {
      this.store.set(this.path, resolved);
    }
  }

  async update(data: Record<string, unknown>): Promise<void> {
    const old = this.store.get(this.path);
    if (!old) {
      throw new Error(`fake-firestore: update on missing doc ${this.path}`);
    }
    const next = deepClone(old);
    for (const [key, value] of Object.entries(data)) {
      if (key.includes('.')) {
        // Dotted path update, one or more levels.
        const parts = key.split('.');
        let cur: Record<string, unknown> = next;
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
          cur = cur[p] as Record<string, unknown>;
        }
        const leaf = parts[parts.length - 1];
        cur[leaf] = resolveSentinels(deepClone(value), cur[leaf]);
      } else {
        next[key] = resolveSentinels(deepClone(value), old[key]);
      }
    }
    this.store.set(this.path, next);
  }

  async delete(): Promise<void> {
    this.store.delete(this.path);
  }
}

class FakeTransaction {
  private readonly staged = new Map<string, Record<string, unknown> | null>();

  constructor(
    private readonly store: Map<string, Record<string, unknown>>,
    private readonly db: FakeFirestore,
  ) {}

  private readRaw(path: string): Record<string, unknown> | undefined {
    if (this.staged.has(path)) {
      const v = this.staged.get(path);
      return v === null ? undefined : v;
    }
    return this.store.get(path);
  }

  async get(ref: FakeDocRef): Promise<FakeDocSnapshot>;
  async get(query: FakeQuery): Promise<FakeQuerySnapshot>;
  async get(target: FakeDocRef | FakeQuery): Promise<FakeDocSnapshot | FakeQuerySnapshot> {
    if (target instanceof FakeDocRef) {
      return new FakeDocSnapshot(target.id, target, this.readRaw(target.path));
    }
    return target.get();
  }

  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): this {
    const old = this.readRaw(ref.path);
    const resolved = resolveSentinels(deepClone(data), old) as Record<string, unknown>;
    if (opts?.merge && old) {
      this.staged.set(ref.path, { ...deepClone(old), ...resolved });
    } else {
      this.staged.set(ref.path, resolved);
    }
    return this;
  }

  update(ref: FakeDocRef, data: Record<string, unknown>): this {
    const old = this.readRaw(ref.path);
    if (!old) throw new Error(`fake-firestore: tx update on missing doc ${ref.path}`);
    const next = deepClone(old);
    for (const [k, v] of Object.entries(data)) {
      next[k] = resolveSentinels(deepClone(v), old[k]);
    }
    this.staged.set(ref.path, next);
    return this;
  }

  delete(ref: FakeDocRef): this {
    this.staged.set(ref.path, null);
    return this;
  }

  _commit(): void {
    for (const [path, data] of this.staged.entries()) {
      if (data === null) this.store.delete(path);
      else this.store.set(path, data);
    }
  }
}

class FakeWriteBatch {
  private readonly ops: Array<() => Promise<void>> = [];

  constructor(private readonly db: FakeFirestore) {}

  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): this {
    this.ops.push(() => ref.set(data, opts));
    return this;
  }

  update(ref: FakeDocRef, data: Record<string, unknown>): this {
    this.ops.push(() => ref.update(data));
    return this;
  }

  delete(ref: FakeDocRef): this {
    this.ops.push(() => ref.delete());
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) await op();
  }
}

export class FakeFirestore {
  private readonly store = new Map<string, Record<string, unknown>>();
  private autoIdCounter = 0;

  _nextAutoId(): string {
    this.autoIdCounter += 1;
    return `fake-auto-id-${this.autoIdCounter}`;
  }

  collection(path: string): FakeCollectionRef {
    return new FakeCollectionRef(this.store, path, this);
  }

  doc(path: string): FakeDocRef {
    return new FakeDocRef(this.store, path, this);
  }

  collectionGroup(name: string): FakeQuery {
    const self = this;
    const q = new FakeQuery(this.store, '', this);
    // Override matching: any doc whose parent collection's last segment is `name`.
    (q as unknown as { matchingDocs: () => Array<[string, Record<string, unknown>]> }).matchingDocs =
      function (this: FakeQuery) {
        const out: Array<[string, Record<string, unknown>]> = [];
        for (const [path, data] of self.store.entries()) {
          const parts = path.split('/');
          if (parts.length >= 2 && parts[parts.length - 2] === name) {
            if ((this as unknown as { matches: (d: Record<string, unknown>) => boolean }).matches(data)) {
              out.push([path, data]);
            }
          }
        }
        return out;
      };
    return q;
  }

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction(this.store, this);
    const result = await fn(tx);
    tx._commit();
    return result;
  }

  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this);
  }

  /** Test-only: raw view of every stored doc, for anonymity assertions. */
  _dump(): Map<string, Record<string, unknown>> {
    return new Map(this.store);
  }
}

export function createFakeDb(): FakeFirestore {
  return new FakeFirestore();
}

// ---------------------------------------------------------------------------
// Fake 'firebase-admin' module (jest.mock factory)
// ---------------------------------------------------------------------------

export function fakeFirebaseAdminModule(): Record<string, unknown> {
  const firestoreFn = Object.assign(
    () => {
      throw new Error('fake-firestore: call createFakeDb() and inject the db instead');
    },
    {
      Timestamp: FakeTimestamp,
      FieldValue: {
        serverTimestamp: () => new ServerTimestampSentinel(),
        increment: (n: number) => new IncrementSentinel(n),
        delete: () => null,
      },
    },
  );
  const admin = {
    firestore: firestoreFn,
    apps: [{}],
    initializeApp: () => ({}),
    credential: { cert: () => ({}) },
    auth: () => {
      throw new Error('fake-firestore: auth is not part of the fake');
    },
  };
  return { __esModule: true, default: admin, ...admin };
}
