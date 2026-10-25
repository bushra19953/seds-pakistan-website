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
 *   ids target the `id` column. Scalar values are stringified (jsonb's
 *   canonical text form), so string/number/boolean equality is exact.
 *   Dates and Firestore-Timestamp-like values ({ toDate() }) become ISO
 *   strings first.
 * - '==' '!=' '<' '<=' '>' '>=' map to eq/neq/lt/lte/gt/gte; 'in' maps to
 *   PostgREST `in`; 'array-contains' maps to a jsonb containment filter
 *   (`data->'<field>' cs '[<value>]'`); '==' with null maps to `is null`.
 * - orderBy on a field orders by `data->>'<field>'` (text order); orderBy on
 *   'id' or '__name__' orders by the id column.
 * - startAfter is a cursor VALUE, matching how this codebase paginates:
 *   with an explicit data-field order it becomes a gt/lt bound on that
 *   field (direction-aware); otherwise it pages by document id
 *   (`id > startAfter`, id ascending — the migration kit's own pattern).
 *
 * Known limits, stated plainly:
 * - Range comparisons and ordering on numeric fields compare the text
 *   extraction, not the number ('100' < '99' as text). Equality is exact;
 *   surfaces that need numeric ranges keep Firestore until their data shape
 *   earns a dedicated column.
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
    data,
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

function applyWhere(chain: SupaFilterChain, clause: WhereClause): SupaFilterChain {
  const [field, op, value] = clause;
  const textColumn = `data->>'${field}'`;
  if (op === 'in') {
    if (!Array.isArray(value)) {
      throw new SupaAdapterError(`'in' filter on ${field} needs an array value`, 'bad-where');
    }
    return chain.in(textColumn, value.map(scalarText));
  }
  if (op === 'array-contains') {
    return chain.filter(`data->'${field}'`, 'cs', JSON.stringify([value]));
  }
  if (value === null && op === '==') return chain.is(textColumn, null);
  if (value === null && op === '!=') return chain.not(textColumn, 'is', null);
  const method = POSTGREST_OPS[op];
  if (!method) {
    throw new SupaAdapterError(`unsupported where op: ${op}`, 'bad-where');
  }
  return chain[method](textColumn, scalarText(value));
}

function applyWheres(chain: SupaFilterChain, where?: WhereClause[]): SupaFilterChain {
  let out = chain;
  for (const clause of where ?? []) out = applyWhere(out, clause);
  return out;
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
  return field === 'id' || field === '__name__' ? 'id' : `data->>'${field}'`;
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
    return { id: row.id, ...data };
  }

  function fail(error: { message: string } | null, context: string): void {
    if (error) throw new SupaAdapterError(`${context}: ${error.message}`, 'query-failed');
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
    let chain = db.from(target.table).select('id, data');
    chain = parentScoped(chain, target);
    chain = applyWheres(chain, options.where);

    const orders = normalizeOrders(options.orderBy);
    for (const order of orders) {
      chain = chain.order(orderColumn(order.field), {
        ascending: order.direction !== 'desc',
      });
    }

    if (options.startAfter !== undefined) {
      const primary = orders[0];
      if (primary && primary.field !== 'id' && primary.field !== '__name__') {
        const column = orderColumn(primary.field);
        chain =
          primary.direction === 'desc'
            ? chain.lt(column, scalarText(options.startAfter))
            : chain.gt(column, scalarText(options.startAfter));
      } else {
        if (orders.length === 0) chain = chain.order('id', { ascending: true });
        chain = chain.gt('id', String(options.startAfter));
      }
    }

    if (options.limit !== undefined) chain = chain.limit(options.limit);

    const { data, error } = await chain;
    fail(error, `listDocs ${collectionPath}`);
    return (data ?? []).map(toDoc);
  }

  async function countDocs(
    collectionPath: string,
    where?: WhereClause[],
  ): Promise<number> {
    const db = requireClient();
    const target = resolveTarget(collectionPath);
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
    const { error } = await db
      .from(target.table)
      .upsert(writeRow(collectionPath, id, finalData), { onConflict: 'id' });
    fail(error, `setDoc ${collectionPath}/${id}`);
    return { id, ...finalData };
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
    const nextData: DocData = { ...existingData };
    for (const [key, value] of Object.entries(updates)) {
      setDeep(nextData, key.split('.'), value);
    }
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
