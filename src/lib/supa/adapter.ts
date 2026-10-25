/**
 * Firestore-shaped data-access adapter over the Supabase landing tables
 * (server-only; see `client.ts` for the service-key warning).
 *
 * Every Firestore collection lands in one Postgres table named
 * `fs_<collection>` (subcollection families in `fs_group_<name>`), with one
 * row per document:
 *
 *   id           text primary key   the Firestore document id
 *   firebase_uid text               owning user uid, per the migration kit
 *   parent_path  text               doc path minus its last segment
 *   data         jsonb              the document body
 *   migrated_at  timestamptz        written by the database default
 *
 * The row mapping for writes replicates `rowFor()` in
 * ~/workspace/supabase-migration/migrate_db.js exactly, so rows written by
 * this adapter and rows loaded by the dump are indistinguishable.
 *
 * Every read returns Firestore-shaped results — `{ id, ...data }` plain
 * objects and plain counts — so route code that migrates keeps its response
 * shapes and only swaps the data calls.
 *
 * Query translation rules (Firestore -> PostgREST over jsonb):
 * - A field filter targets the text extraction `data->>'<field>'`; document
 *   ids (`id` / `__name__`) target the `id` column — for EVERY operator,
 *   including `in` (adapter contract G1). Scalar values are stringified
 *   (jsonb's canonical text form), so string/number/boolean equality is
 *   exact. '==' '!=' '<' '<=' '>' '>=' map to eq/neq/lt/lte/gt/gte; 'in'
 *   maps to PostgREST `in`; 'array-contains' maps to a jsonb containment
 *   filter (`data->'<field>' cs '[<value>]'`).
 * - Clauses PostgREST text extraction cannot express faithfully are
 *   evaluated by the adapter itself after a paged fetch (see "Client-side
 *   finishing" below): any clause whose value is null ('==' / '!=' null —
 *   jsonb extraction cannot distinguish an explicit null from a missing
 *   key, G8) and any clause whose value is a Date / Timestamp-like /
 *   dumped-timestamp object (G3). `countDocs` falls back to a finished
 *   `listDocs` for those clauses.
 *
 * Timestamp ruling (the migration's #1 silent-failure class; verdict in
 * SUPA_CONTRACTS/ADAPTER_VERDICT.md + TIMESTAMP_CENSUS.md):
 * - STORAGE is ISO strings. The kit normalizes Firestore Timestamps to ISO
 *   at dump/push time, and this adapter normalizes Date / Timestamp-like /
 *   dumped-shape values to ISO on every write, so rows the adapter writes
 *   and rows the fixed kit loads are indistinguishable.
 * - READS rehydrate the legacy dumped shape: any value stored as
 *   `{"_seconds": n, "_nanoseconds": n}` (rows dumped before the kit fix)
 *   comes back as a `SupaTimestamp`, structurally exposing
 *   `seconds` / `nanoseconds` / `toDate()` / `toMillis()` — the surface the
 *   codebase's ~207 `.toDate()`/`.toMillis()` sites use. ISO strings stay
 *   strings; consumers' defensive arms already handle those.
 * - Timestamp COMPARISONS never delegate to jsonb text order (the dumped
 *   JSON text misorders across digit widths and inverts sub-second values,
 *   G3/G5/G6). Filters, ordering, and cursors over timestamp values are
 *   finished client-side in true chronological order.
 *
 * Client-side finishing (listDocs): a query is finished by the adapter —
 * after fetching every server-matching row through an id-keyset paged loop
 * (page size 1000, so unbounded reads never truncate at the PostgREST row
 * cap, G2) — whenever it contains a deferred clause (above), an orderBy on
 * a data field, or a startAfter cursor on a data field. Finishing applies,
 * in order: deferred predicates, the Firestore orderBy existence rule
 * (documents missing an ordered field are excluded, G4), a value-faithful
 * sort (numbers numerically, timestamps chronologically, strings as text)
 * with a document-id-ascending final tiebreak (G4/G7), the cursor bound,
 * and the limit. Cost note: finishing reads the full server-filtered set;
 * the collections in this migration are small and correctness outranks the
 * push-down here. Queries that need none of it (id ordering, scalar
 * filters, id cursors, explicit limits) stay single-shot server queries.
 *
 * Known limits, stated plainly:
 * - SERVER-side range comparisons on numeric fields compare the text
 *   extraction, not the number ('100' < '99' as text). Equality is exact;
 *   surfaces that need numeric ranges keep Firestore until their data shape
 *   earns a dedicated column. (Finished queries compare numbers
 *   numerically — only pure server queries inherit the text limit.)
 * - A numeric (millis) filter value against a timestamp field is compared
 *   by Firestore type order, not as a timestamp; pass a Date or
 *   Timestamp-like value for timestamp semantics. The one exception is
 *   startAfter on a timestamp-ordered field, which accepts a millis cursor
 *   (the tasks list's idiom).
 * - No projection support: `ListOptions` has no field selection, so reads
 *   return full documents. The burn fixes' projected reads (roles overlay,
 *   dashboard pending sample) keep their read-cost contract only on
 *   Firestore until projection lands as a named follow-up.
 * - updateDoc is read-modify-write (PostgREST has no partial-jsonb update);
 *   concurrent writers to the same doc can race, as they could with
 *   Firestore's non-transactional update. Dot-path update keys
 *   ('a.b.c') are expanded into nested objects, as Firestore does.
 * - setDoc with { merge: true } merges top-level keys only.
 *
 * The adapter speaks to the client through a minimal structural interface
 * (`SupaLike`) rather than the SDK's schema-parameterized builder types:
 * this layer is deliberately schema-agnostic, and the seam doubles as the
 * unit-test seam (tests inject a fake client; no live Supabase calls).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupaClient } from './client';

/* ------------------------------------------------------------------ types */

export type DocData = Record<string, unknown>;
export type SupaDoc = { id: string } & DocData;

export type WhereOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'array-contains';
export type WhereClause = [field: string, op: WhereOp, value: unknown];

export interface OrderSpec {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface ListOptions {
  where?: WhereClause[];
  orderBy?: string | OrderSpec | OrderSpec[];
  limit?: number;
  startAfter?: string | number;
}

/* ------------------------------------------------------- structural client */

export interface SupaQueryResult<T> {
  data: T;
  error: { message: string } | null;
  count: number | null;
}

export interface SupaFilterChain
  extends PromiseLike<SupaQueryResult<Record<string, unknown>[]>> {
  eq(column: string, value: unknown): SupaFilterChain;
  neq(column: string, value: unknown): SupaFilterChain;
  lt(column: string, value: unknown): SupaFilterChain;
  lte(column: string, value: unknown): SupaFilterChain;
  gt(column: string, value: unknown): SupaFilterChain;
  gte(column: string, value: unknown): SupaFilterChain;
  in(column: string, values: unknown[]): SupaFilterChain;
  is(column: string, value: null): SupaFilterChain;
  not(column: string, operator: string, value: unknown): SupaFilterChain;
  filter(column: string, operator: string, value: unknown): SupaFilterChain;
  order(column: string, options: { ascending: boolean }): SupaFilterChain;
  limit(count: number): SupaFilterChain;
  maybeSingle(): Promise<SupaQueryResult<{ data: unknown; id: string } | null>>;
}

export interface SupaTableChain {
  select(
    columns: string,
    options?: { count?: 'exact'; head?: boolean },
  ): SupaFilterChain;
  upsert(
    row: Record<string, unknown>,
    options: { onConflict: string },
  ): PromiseLike<SupaQueryResult<unknown>>;
  update(values: Record<string, unknown>): SupaFilterChain;
  delete(): SupaFilterChain;
}

export interface SupaLike {
  from(table: string): SupaTableChain;
}

/* ------------------------------------------------------------------ errors */

export class SupaUnavailableError extends Error {
  constructor() {
    super(
      'Supabase client is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing); caller must fall back to Firestore',
    );
    this.name = 'SupaUnavailableError';
  }
}

export class SupaAdapterError extends Error {
  readonly code: string;
  constructor(message: string, code = 'adapter-error') {
    super(message);
    this.name = 'SupaAdapterError';
    this.code = code;
  }
}

/* ------------------------------------------------------------- timestamps */

/**
 * Timestamp-compatible value returned on reads for fields stored in the
 * legacy dumped shape `{"_seconds","_nanoseconds"}`. Structural stand-in for
 * the Firestore Timestamp surface this codebase consumes (`seconds`,
 * `nanoseconds`, `toDate()`, `toMillis()`, `toISOString()`); it is NOT an
 * instance of the SDK's Timestamp class, so `instanceof Timestamp` checks in
 * consumer code do not see it — none exist in the census paths.
 */
export class SupaTimestamp {
  readonly _seconds: number;
  readonly _nanoseconds: number;

  constructor(seconds: number, nanoseconds: number) {
    this._seconds = seconds;
    this._nanoseconds = nanoseconds;
  }

  get seconds(): number {
    return this._seconds;
  }

  get nanoseconds(): number {
    return this._nanoseconds;
  }

  toMillis(): number {
    return this._seconds * 1000 + this._nanoseconds / 1_000_000;
  }

  toDate(): Date {
    return new Date(this.toMillis());
  }

  toISOString(): string {
    return this.toDate().toISOString();
  }

  static fromMillis(millis: number): SupaTimestamp {
    const seconds = Math.floor(millis / 1000);
    return new SupaTimestamp(seconds, Math.round((millis - seconds * 1000) * 1_000_000));
  }
}

/** The legacy dumped shape: exactly {_seconds, _nanoseconds}, both numeric. */
export function isDumpedTimestamp(value: unknown): value is {
  _seconds: number;
  _nanoseconds: number;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 2 &&
    typeof v._seconds === 'number' &&
    typeof v._nanoseconds === 'number' &&
    Number.isFinite(v._seconds) &&
    Number.isFinite(v._nanoseconds)
  );
}

function hasToMillis(value: object): value is { toMillis: () => number } {
  return typeof (value as { toMillis?: unknown }).toMillis === 'function';
}

function hasToDate(value: object): value is { toDate: () => Date } {
  return typeof (value as { toDate?: unknown }).toDate === 'function';
}

/** Milliseconds for any timestamp-shaped value, else null. */
export function timestampMillis(value: unknown): number | null {
  if (value instanceof SupaTimestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (isDumpedTimestamp(value)) {
    return value._seconds * 1000 + value._nanoseconds / 1_000_000;
  }
  if (value !== null && typeof value === 'object') {
    if (hasToMillis(value)) {
      try {
        const ms = value.toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (hasToDate(value)) {
      try {
        const ms = value.toDate().getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isTimestampLike(value: unknown): boolean {
  return timestampMillis(value) !== null;
}

const ISO_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Milliseconds for an ISO-8601 string, else null. */
function isoMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_TEXT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Deep read transform: legacy dumped timestamps become SupaTimestamp,
 * anywhere in the document. ISO strings and all other values pass through.
 */
export function rehydrateValue(value: unknown): unknown {
  if (isDumpedTimestamp(value)) {
    return new SupaTimestamp(value._seconds, value._nanoseconds);
  }
  if (Array.isArray(value)) return value.map(rehydrateValue);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: DocData = {};
    for (const [k, v] of Object.entries(value as DocData)) {
      out[k] = rehydrateValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Deep write transform (the storage side of the timestamp ruling): Date,
 * Timestamp-like, SupaTimestamp and dumped-shape values become ISO
 * strings; everything else recurses or passes through.
 */
export function normalizeForStorage(value: unknown): unknown {
  const ms = timestampMillis(value);
  if (ms !== null) return new Date(ms).toISOString();
  if (Array.isArray(value)) return value.map(normalizeForStorage);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: DocData = {};
    for (const [k, v] of Object.entries(value as DocData)) {
      out[k] = normalizeForStorage(v);
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------- value comparison */

/**
 * Firestore type ranks for the values this database holds:
 * null < boolean < number < timestamp < string < everything else.
 */
function typeRank(value: unknown, millis: number | null): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (millis !== null) return 3;
  if (typeof value === 'string') return 4;
  return 5;
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/**
 * Firestore-faithful comparison of two field values. When either side is
 * timestamp-like, both sides are read as timestamps when they can be (an
 * ISO string coerces), giving true chronological order in every storage
 * shape; otherwise values compare within their type (numbers numerically,
 * strings as text, booleans false < true) and across types by rank.
 */
export function compareFieldValues(a: unknown, b: unknown): number {
  const ma = timestampMillis(a);
  const mb = timestampMillis(b);
  if (ma !== null || mb !== null) {
    const ta = ma ?? isoMillis(a);
    const tb = mb ?? isoMillis(b);
    if (ta !== null && tb !== null) return sign(ta - tb);
    return sign(typeRank(a, ma) - typeRank(b, mb));
  }
  const ra = typeRank(a, null);
  const rb = typeRank(b, null);
  if (ra !== rb) return sign(ra - rb);
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') return sign(a - b);
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const ja = JSON.stringify(a) ?? '';
  const jb = JSON.stringify(b) ?? '';
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

/* ------------------------------------------------------- target resolution */

/** Table name for a collection name, identical to the migration kit's rule. */
export function tableForCollection(collection: string): string {
  return `fs_${collection.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

interface Target {
  table: string;
  /** parent_path value shared by every doc addressed through this path. */
  parentPath: string;
  isSubcollection: boolean;
}

/**
 * A collection path is either a top-level collection name ('tasks') or a
 * subcollection path ('users/{uid}/notifications',
 * 'events/{id}/registrations') — the only two subcollection families in this
 * database. Subcollection docs live in the collectionGroup landing table
 * `fs_group_<subcollection>`, discriminated by parent_path.
 */
export function resolveTarget(collectionPath: string): Target {
  const segments = collectionPath.split('/').filter(Boolean);
  if (segments.length === 1) {
    return {
      table: tableForCollection(segments[0]),
      parentPath: segments[0],
      isSubcollection: false,
    };
  }
  if (segments.length === 3) {
    return {
      table: tableForCollection(`group_${segments[2]}`),
      parentPath: segments.join('/'),
      isSubcollection: true,
    };
  }
  throw new SupaAdapterError(
    `collection path must be a top-level collection or a 3-segment subcollection path, got: ${collectionPath}`,
    'bad-path',
  );
}

/** firebase_uid for a full document path — the migration kit's rule, verbatim. */
export function firebaseUidForPath(segments: string[]): string | null {
  const ui = segments.indexOf('users');
  if (ui !== -1 && segments[ui + 1]) return segments[ui + 1];
  return null;
}

function writeRow(
  collectionPath: string,
  id: string,
  data: DocData,
): Record<string, unknown> {
  const segments = [...collectionPath.split('/').filter(Boolean), id];
  return {
    id,
    firebase_uid: firebaseUidForPath(segments),
    parent_path: segments.slice(0, -1).join('/') || null,
    data: normalizeForStorage(data),
  };
}

/* --------------------------------------------------------- value coercion */

function scalarText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

const POSTGREST_OPS = {
  '==': 'eq',
  '!=': 'neq',
  '<': 'lt',
  '<=': 'lte',
  '>': 'gt',
  '>=': 'gte',
} as const;

function isIdField(field: string): boolean {
  return field === 'id' || field === '__name__';
}

function whereColumn(field: string): string {
  // G1: document-id filters target the id column for every operator;
  // only ordering special-cased it before, so `where('__name__','in',ids)`
  // silently matched a data field that never exists.
  return isIdField(field) ? 'id' : `data->>'${field}'`;
}

function applyWhere(chain: SupaFilterChain, clause: WhereClause): SupaFilterChain {
  const [field, op, value] = clause;
  const column = whereColumn(field);
  if (op === 'in') {
    if (!Array.isArray(value)) {
      throw new SupaAdapterError(`'in' filter on ${field} needs an array value`, 'bad-where');
    }
    return chain.in(column, value.map(scalarText));
  }
  if (op === 'array-contains') {
    return chain.filter(`data->'${field}'`, 'cs', JSON.stringify([value]));
  }
  if (value === null && op === '==') return chain.is(column, null);
  if (value === null && op === '!=') return chain.not(column, 'is', null);
  const method = POSTGREST_OPS[op];
  if (!method) {
    throw new SupaAdapterError(`unsupported where op: ${op}`, 'bad-where');
  }
  return chain[method](column, scalarText(value));
}

function applyWheres(chain: SupaFilterChain, where?: WhereClause[]): SupaFilterChain {
  let out = chain;
  for (const clause of where ?? []) out = applyWhere(out, clause);
  return out;
}

/**
 * A clause is deferred to client-side finishing when PostgREST text
 * extraction cannot express it faithfully: null comparisons (extraction
 * yields SQL NULL for an explicit null AND for a missing key — G8) and any
 * clause carrying a Date / Timestamp-like / dumped-timestamp value (the
 * stored text and the filter text are different representations — G3).
 */
export function isDeferredClause(clause: WhereClause): boolean {
  const [, op, value] = clause;
  if (op === 'array-contains') return false;
  if (value === null) return op === '==' || op === '!=';
  if (Array.isArray(value)) {
    return value.some((v) => v === null || isTimestampLike(v));
  }
  return isTimestampLike(value);
}

/** Evaluate one deferred clause against a raw stored document body. */
function matchesDeferred(data: DocData, clause: WhereClause): boolean {
  const [field, op, value] = clause;
  const present =
    Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined;
  if (value === null && (op === '==' || op === '!=')) {
    // G8: Firestore null equality is about an explicit stored null; a
    // missing field matches neither == null nor != null.
    if (!present) return false;
    return op === '==' ? data[field] === null : data[field] !== null;
  }
  if (!present) return false;
  const rowValue = data[field];
  if (op === 'in') {
    if (!Array.isArray(value)) {
      throw new SupaAdapterError(`'in' filter on ${field} needs an array value`, 'bad-where');
    }
    return value.some((v) => compareFieldValues(rowValue, v) === 0);
  }
  const c = compareFieldValues(rowValue, value);
  switch (op) {
    case '==':
      return c === 0;
    case '!=':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    default:
      throw new SupaAdapterError(`unsupported where op: ${op}`, 'bad-where');
  }
}

function normalizeOrders(orderBy?: ListOptions['orderBy']): OrderSpec[] {
  if (!orderBy) return [];
  if (typeof orderBy === 'string') return [{ field: orderBy, direction: 'asc' }];
  return (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => ({
    field: o.field,
    direction: o.direction ?? 'asc',
  }));
}

function orderColumn(field: string): string {
  return isIdField(field) ? 'id' : `data->>'${field}'`;
}

/** Page size for the unbounded-read loop (the PostgREST response cap). */
const PAGE_SIZE = 1000;
const MAX_PAGES = 10_000;

interface RawRow {
  id: string;
  data: DocData;
}

/* ----------------------------------------------------------------- adapter */

export interface SupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(collectionPath: string, options?: ListOptions): Promise<SupaDoc[]>;
  countDocs(collectionPath: string, where?: WhereClause[]): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: DocData,
    options?: { merge?: boolean },
  ): Promise<SupaDoc>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: DocData,
  ): Promise<SupaDoc>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

export function createSupaAdapter(client: SupabaseClient | null): SupaAdapter {
  const supa = client as unknown as SupaLike | null;

  function requireClient(): SupaLike {
    if (!supa) throw new SupaUnavailableError();
    return supa;
  }

  function parentScoped(chain: SupaFilterChain, target: Target): SupaFilterChain {
    return target.isSubcollection
      ? chain.eq('parent_path', target.parentPath)
      : chain;
  }

  function toDoc(row: { id: string; data: unknown }): SupaDoc {
    const data = (row.data ?? {}) as DocData;
    const out: DocData = {};
    for (const [k, v] of Object.entries(data)) out[k] = rehydrateValue(v);
    return { id: row.id, ...out };
  }

  function fail(error: { message: string } | null, context: string): void {
    if (error) throw new SupaAdapterError(`${context}: ${error.message}`, 'query-failed');
  }

  /**
   * Fetch every row the server-side clauses match, paging by document id
   * so a response cap can never silently truncate the set (G2).
   */
  async function fetchAllRows(
    target: Target,
    collectionPath: string,
    serverClauses: WhereClause[],
  ): Promise<RawRow[]> {
    const db = requireClient();
    const rows: RawRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      let chain = db.from(target.table).select('id, data');
      chain = parentScoped(chain, target);
      chain = applyWheres(chain, serverClauses);
      chain = chain.order('id', { ascending: true });
      if (cursor !== null) chain = chain.gt('id', cursor);
      chain = chain.limit(PAGE_SIZE);
      const { data, error } = await chain;
      fail(error, `listDocs ${collectionPath}`);
      const batch = (data ?? []) as RawRow[];
      let added = 0;
      for (const row of batch) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push({ id: row.id, data: (row.data ?? {}) as DocData });
          added++;
        }
      }
      if (batch.length < PAGE_SIZE || added === 0) break;
      cursor = batch[batch.length - 1].id;
    }
    return rows;
  }

  async function getDoc(collectionPath: string, id: string): Promise<SupaDoc | null> {
    const db = requireClient();
    const target = resolveTarget(collectionPath);
    let chain = db.from(target.table).select('id, data').eq('id', id);
    chain = parentScoped(chain, target);
    const { data, error } = await chain.maybeSingle();
    fail(error, `getDoc ${collectionPath}/${id}`);
    return data ? toDoc(data) : null;
  }

  async function listDocs(
    collectionPath: string,
    options: ListOptions = {},
  ): Promise<SupaDoc[]> {
    const db = requireClient();
    const target = resolveTarget(collectionPath);
    const orders = normalizeOrders(options.orderBy);
    const deferred: WhereClause[] = [];
    const serverClauses: WhereClause[] = [];
    for (const clause of options.where ?? []) {
      (isDeferredClause(clause) ? deferred : serverClauses).push(clause);
    }
    const primary = orders[0];
    const cursorOnDataField =
      options.startAfter !== undefined &&
      primary !== undefined &&
      !isIdField(primary.field);
    const needsFinishing =
      deferred.length > 0 ||
      cursorOnDataField ||
      orders.some((o) => !isIdField(o.field));

    if (options.limit !== undefined && !needsFinishing) {
      // Single-shot server query: bounded, id ordering, scalar filters,
      // id cursors — nothing the text extraction can get wrong.
      let chain = db.from(target.table).select('id, data');
      chain = parentScoped(chain, target);
      chain = applyWheres(chain, serverClauses);
      for (const order of orders) {
        chain = chain.order(orderColumn(order.field), {
          ascending: order.direction !== 'desc',
        });
      }
      if (options.startAfter !== undefined) {
        if (orders.length === 0) chain = chain.order('id', { ascending: true });
        chain =
          primary && primary.direction === 'desc'
            ? chain.lt('id', String(options.startAfter))
            : chain.gt('id', String(options.startAfter));
      }
      chain = chain.limit(options.limit);
      const { data, error } = await chain;
      fail(error, `listDocs ${collectionPath}`);
      return (data ?? []).map(toDoc);
    }

    // Everything else fetches the full server-filtered set through the
    // paged loop (an unbounded read must never truncate at the cap, G2),
    // then applies the finishing steps the query needs.
    let docs = await fetchAllRows(target, collectionPath, serverClauses);
    if (deferred.length > 0) {
      docs = docs.filter((d) => deferred.every((c) => matchesDeferred(d.data, c)));
    }
    // G4: orderBy excludes documents missing the ordered field. An explicit
    // stored null is a value and stays.
    for (const order of orders) {
      if (!isIdField(order.field)) {
        docs = docs.filter(
          (d) =>
            Object.prototype.hasOwnProperty.call(d.data, order.field) &&
            d.data[order.field] !== undefined,
        );
      }
    }
    if (orders.length > 0) {
      docs = [...docs].sort((a, b) => {
        for (const order of orders) {
          const c = isIdField(order.field)
            ? a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0
            : compareFieldValues(a.data[order.field], b.data[order.field]);
          if (c !== 0) return order.direction === 'desc' ? -c : c;
        }
        // G4/G7: Firestore's final tiebreak is document id, ascending.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    if (options.startAfter !== undefined && primary) {
      if (cursorOnDataField) {
        const field = primary.field;
        const cursor = options.startAfter;
        // A millis cursor against a timestamp field compares as millis
        // (the tasks list's idiom); anything else compares as a value.
        const sample = docs.find((d) => timestampMillis(d.data[field]) !== null);
        const cursorMillis =
          timestampMillis(cursor) ??
          (typeof cursor === 'number' && sample ? cursor : isoMillis(cursor));
        docs = docs.filter((d) => {
          if (cursorMillis !== null) {
            const ms = timestampMillis(d.data[field]) ?? isoMillis(d.data[field]);
            if (ms === null) return false;
            return primary.direction === 'desc'
              ? ms < cursorMillis
              : ms > cursorMillis;
          }
          const c = compareFieldValues(d.data[field], cursor);
          return primary.direction === 'desc' ? c < 0 : c > 0;
        });
      } else {
        const cursor = String(options.startAfter);
        docs = docs.filter((d) =>
          primary.direction === 'desc' ? d.id < cursor : d.id > cursor,
        );
      }
    } else if (options.startAfter !== undefined) {
      // No ordering at all: the cursor pages by document id (fetch order).
      const cursor = String(options.startAfter);
      docs = docs.filter((d) => d.id > cursor);
    }
    if (options.limit !== undefined) docs = docs.slice(0, options.limit);
    return docs.map(toDoc);
  }

  async function countDocs(
    collectionPath: string,
    where?: WhereClause[],
  ): Promise<number> {
    const db = requireClient();
    const target = resolveTarget(collectionPath);
    if ((where ?? []).some(isDeferredClause)) {
      // A head count cannot express deferred clauses; count the finished
      // list instead of silently miscounting against the wrong semantics.
      return (await listDocs(collectionPath, { where })).length;
    }
    let chain = db
      .from(target.table)
      .select('id', { count: 'exact', head: true });
    chain = parentScoped(chain, target);
    chain = applyWheres(chain, where);
    const { count, error } = await chain;
    fail(error, `countDocs ${collectionPath}`);
    return count ?? 0;
  }

  async function setDoc(
    collectionPath: string,
    id: string,
    data: DocData,
    options?: { merge?: boolean },
  ): Promise<SupaDoc> {
    const db = requireClient();
    const target = resolveTarget(collectionPath); // validates the path before any write
    let finalData = data;
    if (options?.merge) {
      const existing = await getDoc(collectionPath, id);
      if (existing) {
        const { id: _existingId, ...existingData } = existing;
        void _existingId;
        finalData = { ...existingData, ...data };
      }
    }
    const row = writeRow(collectionPath, id, finalData);
    const { error } = await db
      .from(target.table)
      .upsert(row, { onConflict: 'id' });
    fail(error, `setDoc ${collectionPath}/${id}`);
    return { id, ...(row.data as DocData) };
  }

  async function updateDoc(
    collectionPath: string,
    id: string,
    updates: DocData,
  ): Promise<SupaDoc> {
    const db = requireClient();
    const target = resolveTarget(collectionPath);
    const existing = await getDoc(collectionPath, id);
    if (!existing) {
      // Firestore update() rejects on a missing document; keep that contract.
      throw new SupaAdapterError(
        `updateDoc on missing document ${collectionPath}/${id}`,
        'not-found',
      );
    }
    const { id: _existingId, ...existingData } = existing;
    void _existingId;
    const merged: DocData = { ...existingData };
    for (const [key, value] of Object.entries(updates)) {
      setDeep(merged, key.split('.'), value);
    }
    const nextData = normalizeForStorage(merged) as DocData;
    let chain = db.from(target.table).update({ data: nextData }).eq('id', id);
    chain = parentScoped(chain, target);
    const { error } = await chain;
    fail(error, `updateDoc ${collectionPath}/${id}`);
    return { id, ...nextData };
  }

  async function deleteDoc(collectionPath: string, id: string): Promise<void> {
    const db = requireClient();
    const target = resolveTarget(collectionPath);
    let chain = db.from(target.table).delete().eq('id', id);
    chain = parentScoped(chain, target);
    const { error } = await chain;
    fail(error, `deleteDoc ${collectionPath}/${id}`);
  }

  return { getDoc, listDocs, countDocs, setDoc, updateDoc, deleteDoc };
}

function setDeep(target: DocData, parts: string[], value: unknown): void {
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    const next =
      child !== null && typeof child === 'object' && !Array.isArray(child)
        ? { ...(child as DocData) }
        : {};
    cursor[part] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
}

/* ------------------------------------------- default adapter (env client) */

let defaultAdapter: SupaAdapter | null = null;
let defaultAdapterClient: SupabaseClient | null = null;

/**
 * Adapter bound to the process's env-configured client. When Supabase is not
 * configured, every operation rejects with SupaUnavailableError — gate calls
 * with `useSupa(surface)` (flags.ts) and a client check, and fall back to
 * Firestore.
 */
export function getSupaAdapter(): SupaAdapter {
  const client = getSupaClient();
  if (!defaultAdapter || defaultAdapterClient !== client) {
    defaultAdapter = createSupaAdapter(client);
    defaultAdapterClient = client;
  }
  return defaultAdapter;
}
