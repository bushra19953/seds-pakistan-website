/**
 * Firestore-shaped db handle over the Supabase adapter — the shared seam
 * core for the cron/webhooks/backup cluster (cluster S).
 *
 * The cluster's delegated libraries (role-reconciliation, term-sweep,
 * miss-records, consent-service, discipline/*, compliance/*, elections,
 * lifecycle-cron, retention engine, backup engine, governance modules,
 * notification-service, webhook handlers) all receive a Firestore `db`
 * handle as a parameter and call the Admin-SDK surface on it:
 * collection()/doc()/batch()/runTransaction(), query chaining, doc refs,
 * snapshots, and FieldValue sentinels in write payloads. The migration
 * does NOT fork those libraries (they migrate once, under their owning
 * clusters); instead, when a surface's flag is ON, the route passes THIS
 * handle in place of the real Firestore db. The handle translates every
 * call to the flat adapter (`src/lib/supa`) over the fs_* landing tables.
 *
 * Usage from a route (the only edit a migrated route needs):
 *
 *   const db = supaDbHandleFor('cron-g1') ?? getDb();
 *
 * `supaDbHandleFor` returns null unless the surface flag is ON *and* a
 * Supabase client is configured, so the fallback is byte-identical
 * Firestore behavior.
 *
 * EMULATION CONTRACT — where the adapter's op set (get/list/count/set/
 * update/delete) cannot express Firestore semantics, this handle emulates
 * and the differences are stated here, once, for the whole cluster:
 *
 * - WRITE BATCHES are collect-then-commit: ops apply sequentially in
 *   insertion order at commit(). Firestore batches are atomic; this is
 *   NOT. A failure mid-commit leaves earlier ops applied. (Design plans
 *   C-G1-3 / C-G3-1 sanction exactly this emulation or the surface stays
 *   Firestore-backed.)
 * - TRANSACTIONS are read-live + buffer-writes + apply-at-return: reads
 *   inside the callback hit the adapter immediately (Firestore would
 *   snapshot them), writes buffer and apply sequentially when the
 *   callback resolves. There is no contention detection and no retry —
 *   atomicity and isolation are NOT provided. Callers whose correctness
 *   rests on a check-then-write inside one transaction (the consent
 *   deemed-withheld stamp, the webhook reward's rewardApplied guard, the
 *   discipline derived counter) keep their check and their write in the
 *   same invocation, so single-invocation behavior matches; two
 *   CONCURRENT invocations can interleave where Firestore would have
 *   serialized them. That residual race is the recorded flip-readiness
 *   caveat for those surfaces (C-G2-1 / C-G3-5 / C-G5-1).
 * - FieldValue sentinels are detected structurally (the Admin SDK's
 *   transform objects carry a `methodName` of 'FieldValue.*') and
 *   resolved at write-apply time against freshly read state:
 *   serverTimestamp -> the apply-time Date (the adapter stores ISO,
 *   per the program's timestamp ruling); delete -> the key is REMOVED
 *   (never nulled); increment -> current numeric value + operand
 *   (missing field -> the operand; non-numeric current -> loud error,
 *   as Firestore errors); arrayUnion/arrayRemove -> deep-equality
 *   membership against the current array. Resolving state-dependent
 *   sentinels makes update() a read-apply-write — the same
 *   read-modify-write character the adapter's own updateDoc declares.
 * - update() on a missing document throws (code 'not-found'), matching
 *   Firestore. set() with { merge: true } merges top-level keys (with
 *   nested sentinel resolution), matching Firestore's merge for the
 *   payload shapes this codebase writes. A delete sentinel in a
 *   non-merge set() throws, as Firestore's does.
 * - Snapshot data() returns the stored fields without the synthetic
 *   `id` the adapter merges in (Firestore doc data has no id field
 *   unless one was stored). Values come back in the adapter's read
 *   shapes: dumped timestamps rehydrated to SupaTimestamp, adapter-
 *   written timestamps as ISO strings. Group seams rehydrate named
 *   fields to Timestamp-like objects where their plan requires it
 *   (see `rehydrateTimestampFields`).
 * - Auto-ids for add()/doc() are 20 chars from Firestore's alphabet.
 * - Query operators outside the adapter's set ('array-contains-any',
 *   'not-in', ...) throw loudly instead of silently mistranslating.
 * - Collection paths deeper than a 3-segment subcollection path throw
 *   (the adapter's addressing limit), loudly.
 */

import {
  createSupaAdapter,
  getSupaAdapter,
  getSupaClient,
  useSupa,
  type SupaAdapter,
  type SupaDoc,
  type WhereClause,
} from '../supa';
// SupaTimestamp is not re-exported by the package index; import the class
// from the adapter module itself.
import { SupaTimestamp } from '../supa/adapter';

/* ------------------------------------------------------------ sentinels */

type Sentinel =
  | { kind: 'serverTimestamp' }
  | { kind: 'delete' }
  | { kind: 'increment'; operand: number }
  | { kind: 'arrayUnion'; elements: unknown[] }
  | { kind: 'arrayRemove'; elements: unknown[] };

/**
 * Structural FieldValue detection: the Admin SDK's transform classes
 * expose a `methodName` getter ('FieldValue.serverTimestamp', ...) and
 * carry `operand` (increment) / `elements` (arrayUnion/arrayRemove) as
 * own properties. Works for values constructed by any copy of
 * firebase-admin / @google-cloud/firestore in the process.
 */
function sentinelOf(value: unknown): Sentinel | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { methodName?: unknown; operand?: unknown; elements?: unknown };
  if (typeof v.methodName !== 'string' || !v.methodName.startsWith('FieldValue.')) {
    return null;
  }
  switch (v.methodName) {
    case 'FieldValue.serverTimestamp':
      return { kind: 'serverTimestamp' };
    case 'FieldValue.delete':
      return { kind: 'delete' };
    case 'FieldValue.increment':
      return { kind: 'increment', operand: Number(v.operand) };
    case 'FieldValue.arrayUnion':
      return { kind: 'arrayUnion', elements: Array.isArray(v.elements) ? v.elements : [] };
    case 'FieldValue.arrayRemove':
      return { kind: 'arrayRemove', elements: Array.isArray(v.elements) ? v.elements : [] };
    default:
      throw new Error(`supa-db-handle: unsupported FieldValue sentinel ${v.methodName}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const DELETE_KEY = Symbol('supa-handle-delete-key');

/**
 * Resolve a write payload against the document's current state,
 * translating sentinels at any depth. Returns the plain payload to
 * store; keys whose value resolves to DELETE_KEY are removed by the
 * caller (top level) or in place (nested objects). `current` is the
 * existing field value at the same path (undefined when absent).
 */
function resolveValue(value: unknown, current: unknown): unknown {
  const sentinel = sentinelOf(value);
  if (sentinel) {
    switch (sentinel.kind) {
      case 'serverTimestamp':
        return new Date();
      case 'delete':
        return DELETE_KEY;
      case 'increment': {
        if (current === undefined) return sentinel.operand;
        if (typeof current !== 'number') {
          throw new Error(
            'supa-db-handle: FieldValue.increment on a non-numeric field',
          );
        }
        return current + sentinel.operand;
      }
      case 'arrayUnion': {
        const base = Array.isArray(current) ? [...current] : [];
        for (const el of sentinel.elements) {
          const resolved = resolveValue(el, undefined);
          if (!base.some((existing) => deepEqual(existing, resolved))) {
            base.push(resolved);
          }
        }
        return base;
      }
      case 'arrayRemove': {
        const base = Array.isArray(current) ? current : [];
        const drop = sentinel.elements.map((el) => resolveValue(el, undefined));
        return base.filter(
          (existing) => !drop.some((d) => deepEqual(existing, d)),
        );
      }
    }
  }
  if (Array.isArray(value)) {
    // Sentinels do not appear inside arrays in Firestore payloads
    // (Firestore rejects them); resolve elements as plain values.
    return value.map((el) => resolveValue(el, undefined));
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !isTimestampLike(value)
  ) {
    const currentObj =
      current !== null && typeof current === 'object'
        ? (current as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const resolved = resolveValue(v, currentObj[k]);
      if (resolved !== DELETE_KEY) out[k] = resolved;
    }
    return out;
  }
  return value;
}

function isTimestampLike(value: object): boolean {
  return (
    typeof (value as { toMillis?: unknown }).toMillis === 'function' ||
    typeof (value as { toDate?: unknown }).toDate === 'function'
  );
}

/** Resolve a whole payload against the current document body. */
function resolvePayload(
  payload: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const resolved = resolveValue(v, current[k]);
    if (resolved !== DELETE_KEY) out[k] = resolved;
  }
  return out;
}

/** Expand Firestore update() dot-path keys ('a.b.c') into nested objects. */
function expandDotPaths(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!key.includes('.')) {
      out[key] = value;
      continue;
    }
    const parts = key.split('.');
    let cursor = out;
    for (const part of parts.slice(0, -1)) {
      const child = cursor[part];
      cursor[part] =
        child !== null && typeof child === 'object' && !Array.isArray(child)
          ? { ...(child as Record<string, unknown>) }
          : {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return out;
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const existing = out[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date) &&
      !isTimestampLike(v) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      !(existing instanceof Date)
    ) {
      out[k] = deepMerge(
        existing as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ------------------------------------------------------------- auto-ids */

const AUTO_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function autoId(): string {
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += AUTO_ID_ALPHABET[Math.floor(Math.random() * AUTO_ID_ALPHABET.length)];
  }
  return id;
}

/* -------------------------------------------------------------- helpers */

/** Split a full doc path into the adapter's (collectionPath, id) pair. */
function splitDocPath(path: string): { collectionPath: string; id: string } {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error(`supa-db-handle: not a document path: ${path}`);
  }
  return {
    collectionPath: segments.slice(0, -1).join('/'),
    id: segments[segments.length - 1],
  };
}

function stripSyntheticId(doc: SupaDoc): Record<string, unknown> {
  const { id: _id, ...rest } = doc;
  void _id;
  return rest;
}

function notFoundError(path: string): Error & { code: string } {
  const err = new Error(
    `supa-db-handle: update on missing document ${path}`,
  ) as Error & { code: string };
  err.code = 'not-found';
  return err;
}

/**
 * Rehydrate named top-level fields of a snapshot-shaped doc from ISO
 * strings to SupaTimestamp — the per-group seam tool for the timestamp
 * hotspots the design plans name (consumers calling .toDate()/.toMillis()
 * on a field that jsonb stores as an ISO string). Fields that are absent
 * or not ISO strings pass through untouched, as do fields already
 * Timestamp-like.
 */
export function rehydrateTimestampFields<T extends Record<string, unknown>>(
  data: T,
  fields: string[],
): T {
  const out: Record<string, unknown> = { ...data };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) {
        out[field] = SupaTimestamp.fromMillis(ms);
      }
    }
  }
  return out as T;
}

/* ----------------------------------------------------------------- refs */

export class SupaDocSnapshot {
  constructor(
    readonly id: string,
    readonly ref: SupaDocRef,
    private readonly docData: Record<string, unknown> | null,
  ) {}

  get exists(): boolean {
    return this.docData !== null;
  }

  data(): Record<string, unknown> | undefined {
    return this.docData ?? undefined;
  }
}

export class SupaQuerySnapshot {
  constructor(readonly docs: SupaDocSnapshot[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }

  forEach(callback: (doc: SupaDocSnapshot) => void): void {
    this.docs.forEach(callback);
  }
}

type Order = { field: string; direction: 'asc' | 'desc' };

const SUPPORTED_OPS = new Set([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'array-contains',
]);

export class SupaQuery {
  constructor(
    protected readonly adapter: SupaAdapter,
    readonly collectionPath: string,
    protected readonly wheres: WhereClause[] = [],
    protected readonly orders: Order[] = [],
    protected readonly limitN?: number,
    protected readonly startAfterValue?: unknown,
    protected readonly hasStartAfter = false,
  ) {}

  where(field: string, op: string, value: unknown): SupaQuery {
    if (!SUPPORTED_OPS.has(op)) {
      throw new Error(`supa-db-handle: unsupported where operator '${op}'`);
    }
    return new SupaQuery(
      this.adapter,
      this.collectionPath,
      [...this.wheres, [field, op as WhereClause[1], value]],
      this.orders,
      this.limitN,
      this.startAfterValue,
      this.hasStartAfter,
    );
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): SupaQuery {
    return new SupaQuery(
      this.adapter,
      this.collectionPath,
      this.wheres,
      [...this.orders, { field, direction }],
      this.limitN,
      this.startAfterValue,
      this.hasStartAfter,
    );
  }

  limit(n: number): SupaQuery {
    return new SupaQuery(
      this.adapter,
      this.collectionPath,
      this.wheres,
      this.orders,
      n,
      this.startAfterValue,
      this.hasStartAfter,
    );
  }

  startAfter(snapshotOrValue: unknown): SupaQuery {
    return new SupaQuery(
      this.adapter,
      this.collectionPath,
      this.wheres,
      this.orders,
      this.limitN,
      snapshotOrValue,
      true,
    );
  }

  protected async execute(): Promise<SupaDoc[]> {
    let startAfter: unknown;
    if (this.hasStartAfter) {
      const v = this.startAfterValue;
      const primary = this.orders[0];
      if (
        v !== null &&
        typeof v === 'object' &&
        typeof (v as { data?: unknown }).data === 'function' &&
        typeof (v as { id?: unknown }).id === 'string'
      ) {
        // A document snapshot cursor: id ordering pages by id; a data
        // field ordering pages by that field's snapshot value (the
        // backup wrapper's orderBy('__name__') + startAfter(lastDoc)
        // idiom lands on the id branch).
        const snap = v as SupaDocSnapshot;
        if (!primary || primary.field === '__name__' || primary.field === 'id') {
          startAfter = snap.id;
        } else {
          startAfter = snap.data()?.[primary.field];
        }
      } else {
        startAfter = v;
      }
    }
    return this.adapter.listDocs(this.collectionPath, {
      where: this.wheres,
      orderBy: this.orders.map((o) => ({
        field: o.field === '__name__' ? 'id' : o.field,
        direction: o.direction,
      })),
      limit: this.limitN,
      startAfter: startAfter as never,
    });
  }

  async get(): Promise<SupaQuerySnapshot> {
    const docs = await this.execute();
    return new SupaQuerySnapshot(
      docs.map(
        (doc) =>
          new SupaDocSnapshot(
            doc.id,
            new SupaDocRef(this.adapter, `${this.collectionPath}/${doc.id}`),
            stripSyntheticId(doc),
          ),
      ),
    );
  }

  count(): { get: () => Promise<{ data: () => { count: number } }> } {
    const wheres = this.wheres;
    const adapter = this.adapter;
    const collectionPath = this.collectionPath;
    return {
      get: async () => {
        const count = await adapter.countDocs(collectionPath, wheres);
        return { data: () => ({ count }) };
      },
    };
  }

  async add(data: Record<string, unknown>): Promise<SupaDocRef> {
    const ref = new SupaDocRef(this.adapter, `${this.collectionPath}/${autoId()}`);
    await ref.set(data);
    return ref;
  }
}

export class SupaDocRef {
  constructor(
    private readonly adapter: SupaAdapter,
    readonly path: string,
  ) {}

  get id(): string {
    return this.path.split('/').pop() as string;
  }

  collection(name: string): SupaCollectionRef {
    return new SupaCollectionRef(this.adapter, `${this.path}/${name}`);
  }

  async get(): Promise<SupaDocSnapshot> {
    const { collectionPath, id } = splitDocPath(this.path);
    const doc = await this.adapter.getDoc(collectionPath, id);
    return new SupaDocSnapshot(
      id,
      this,
      doc ? stripSyntheticId(doc) : null,
    );
  }

  async set(
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<void> {
    const { collectionPath, id } = splitDocPath(this.path);
    if (!options?.merge) {
      // A delete sentinel in a plain set() is an error in Firestore.
      const resolved = resolvePayload(data, {});
      await this.adapter.setDoc(collectionPath, id, resolved);
      return;
    }
    const existing = await this.adapter.getDoc(collectionPath, id);
    const current = existing ? stripSyntheticId(existing) : {};
    const resolved = resolvePayload(data, current);
    const merged = deepMerge(current, resolved);
    await this.adapter.setDoc(collectionPath, id, merged);
  }

  async update(data: Record<string, unknown>): Promise<void> {
    const { collectionPath, id } = splitDocPath(this.path);
    const existing = await this.adapter.getDoc(collectionPath, id);
    if (!existing) throw notFoundError(this.path);
    const current = stripSyntheticId(existing);
    const expanded = expandDotPaths(data);
    const resolved = resolvePayload(expanded, current);
    const next = deepMerge(current, resolved);
    // Keys deleted via sentinel must actually disappear: deepMerge
    // cannot express removal, so recompute deletions explicitly.
    applyDeletions(next, expanded, current);
    await this.adapter.setDoc(collectionPath, id, next);
  }

  async delete(): Promise<void> {
    const { collectionPath, id } = splitDocPath(this.path);
    await this.adapter.deleteDoc(collectionPath, id);
  }
}

/**
 * Remove keys whose update value was a delete sentinel, at any depth
 * (dot-path keys were already expanded, so walk the expanded tree).
 */
function applyDeletions(
  next: Record<string, unknown>,
  expanded: Record<string, unknown>,
  current: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expanded)) {
    if (sentinelOf(value)?.kind === 'delete') {
      delete next[key];
      continue;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !isTimestampLike(value)
    ) {
      const nextChild = next[key];
      const currentChild = current[key];
      if (
        nextChild !== null &&
        typeof nextChild === 'object' &&
        !Array.isArray(nextChild)
      ) {
        applyDeletions(
          nextChild as Record<string, unknown>,
          value as Record<string, unknown>,
          (currentChild ?? {}) as Record<string, unknown>,
        );
      }
    }
  }
}

export class SupaCollectionRef extends SupaQuery {
  constructor(adapter: SupaAdapter, collectionPath: string) {
    super(adapter, collectionPath);
  }

  get path(): string {
    return this.collectionPath;
  }

  get id(): string {
    return this.collectionPath.split('/').pop() as string;
  }

  doc(id?: string): SupaDocRef {
    return new SupaDocRef(
      this.adapter,
      `${this.collectionPath}/${id ?? autoId()}`,
    );
  }
}

type BufferedWrite =
  | { kind: 'set'; ref: SupaDocRef; data: Record<string, unknown>; merge: boolean }
  | { kind: 'update'; ref: SupaDocRef; data: Record<string, unknown> }
  | { kind: 'delete'; ref: SupaDocRef };

async function applyWrite(write: BufferedWrite): Promise<void> {
  switch (write.kind) {
    case 'set':
      await write.ref.set(write.data, write.merge ? { merge: true } : undefined);
      return;
    case 'update':
      await write.ref.update(write.data);
      return;
    case 'delete':
      await write.ref.delete();
      return;
  }
}

/**
 * Transaction emulation (see the module header for the exact contract):
 * reads are live, writes buffer and apply in order when the callback
 * resolves; a throwing callback applies nothing.
 */
export class SupaTransaction {
  private writes: BufferedWrite[] = [];

  async get(target: SupaDocRef | SupaQuery): Promise<SupaDocSnapshot | SupaQuerySnapshot> {
    return target.get();
  }

  set(ref: SupaDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): this {
    this.writes.push({ kind: 'set', ref, data, merge: options?.merge === true });
    return this;
  }

  create(ref: SupaDocRef, data: Record<string, unknown>): this {
    return this.set(ref, data);
  }

  update(ref: SupaDocRef, data: Record<string, unknown>): this {
    this.writes.push({ kind: 'update', ref, data });
    return this;
  }

  delete(ref: SupaDocRef): this {
    this.writes.push({ kind: 'delete', ref });
    return this;
  }

  async commitBuffered(): Promise<void> {
    for (const write of this.writes) await applyWrite(write);
    this.writes = [];
  }
}

/** WriteBatch emulation: collect-then-commit, in insertion order. */
export class SupaWriteBatch {
  private writes: BufferedWrite[] = [];

  constructor(private readonly db: SupaDbHandle) {}

  set(ref: SupaDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): this {
    this.writes.push({ kind: 'set', ref, data, merge: options?.merge === true });
    return this;
  }

  create(ref: SupaDocRef, data: Record<string, unknown>): this {
    return this.set(ref, data);
  }

  update(ref: SupaDocRef, data: Record<string, unknown>): this {
    this.writes.push({ kind: 'update', ref, data });
    return this;
  }

  delete(ref: SupaDocRef): this {
    this.writes.push({ kind: 'delete', ref });
    return this;
  }

  async commit(): Promise<void> {
    void this.db;
    for (const write of this.writes) await applyWrite(write);
    this.writes = [];
  }
}

/** The Firestore-shaped handle itself: what routes pass as `db`. */
export class SupaDbHandle {
  constructor(private readonly adapter: SupaAdapter) {}

  collection(path: string): SupaCollectionRef {
    return new SupaCollectionRef(this.adapter, path);
  }

  doc(path: string): SupaDocRef {
    return new SupaDocRef(this.adapter, path);
  }

  batch(): SupaWriteBatch {
    return new SupaWriteBatch(this);
  }

  async runTransaction<T>(
    updateFunction: (tx: SupaTransaction) => Promise<T>,
  ): Promise<T> {
    const tx = new SupaTransaction();
    const result = await updateFunction(tx);
    await tx.commitBuffered();
    return result;
  }
}

/** Build a handle over an explicit adapter (tests, seam modules). */
export function createSupaDbHandle(adapter: SupaAdapter): SupaDbHandle {
  return new SupaDbHandle(adapter);
}

let sharedHandle: SupaDbHandle | null = null;

/**
 * The cluster's surface gate: the shared adapter-backed handle when the
 * surface's flag is ON and a Supabase client is configured, else null
 * (the caller falls back to the real Firestore db, byte-identical).
 */
export function supaDbHandleFor(surface: string): SupaDbHandle | null {
  if (!useSupa(surface) || !getSupaClient()) return null;
  if (!sharedHandle) sharedHandle = new SupaDbHandle(getSupaAdapter());
  return sharedHandle;
}

/** Test hook: build a handle over a fake client without env flags. */
export function createSupaDbHandleForClient(client: unknown): SupaDbHandle {
  return new SupaDbHandle(
    createSupaAdapter(client as Parameters<typeof createSupaAdapter>[0]),
  );
}
