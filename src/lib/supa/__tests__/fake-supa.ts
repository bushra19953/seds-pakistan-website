/**
 * Faithful in-memory fake of the SupaLike seam (adapter.ts), used by the
 * adapter contract tests. "Faithful" means it reproduces the Postgres /
 * PostgREST semantics the contracts depend on, NOT the semantics the
 * adapter wishes for:
 *
 * - `data->>'f'` text extraction: strings pass through; numbers/booleans
 *   become their JSON text; objects/arrays become their JSON text
 *   (JSON.stringify); a missing key or an explicit null yields SQL NULL.
 * - Any comparison against NULL is not-true (row excluded), except
 *   IS NULL (true) and IS NOT NULL.
 * - ORDER BY compares the extracted text; NULL placement follows
 *   Postgres defaults (ASC: nulls last, DESC: nulls first); ties keep
 *   insertion order (Postgres gives no tiebreak guarantee).
 * - PostgREST caps a response at MAX_ROWS (server default 1000) when
 *   the query carries no explicit limit.
 * - `cs` (contains) on `data->'f'` is jsonb containment.
 *
 * If a contract test fails against this fake, the failure mode is one
 * the real stack would also exhibit.
 */

export interface FakeRow {
  id: string;
  firebase_uid: string | null;
  parent_path: string | null;
  data: Record<string, unknown>;
}

const NULL = Symbol('sql-null');
type TextOrNull = string | typeof NULL;

const MAX_ROWS = 1000;

function textOf(row: FakeRow, column: string): TextOrNull {
  if (column === 'id') return row.id;
  if (column === 'parent_path') return row.parent_path ?? NULL;
  if (column === 'firebase_uid') return row.firebase_uid ?? NULL;
  const m = /^data->>'(.+)'$/.exec(column);
  if (m) {
    const v = row.data[m[1]];
    if (v === undefined || v === null) return NULL;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  }
  throw new Error(`fake-supa: unsupported column ${column}`);
}

function rawOf(row: FakeRow, column: string): unknown {
  const m = /^data->'(.+)'$/.exec(column);
  if (!m) throw new Error(`fake-supa: unsupported raw column ${column}`);
  return row.data[m[1]];
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Predicate = (row: FakeRow) => boolean;
type OrderSpec = { column: string; ascending: boolean };

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

class FakeChain implements PromiseLike<QueryResult> {
  private predicates: Predicate[] = [];
  private orders: OrderSpec[] = [];
  private limitValue: number | null = null;

  constructor(
    private fake: FakeSupa,
    private table: string,
    private mode: 'select' | 'update' | 'delete',
    private countHead = false,
    private updateValues: Record<string, unknown> | null = null,
  ) {}

  private cmp(op: (a: string, b: string) => boolean) {
    return (column: string, value: unknown) => {
      const expected = value === null || value === undefined ? NULL : String(value);
      this.predicates.push((row) => {
        const actual = textOf(row, column);
        if (actual === NULL || expected === NULL) return false;
        return op(actual, expected);
      });
      return this;
    };
  }

  eq = this.cmp((a, b) => a === b);
  neq = this.cmp((a, b) => a !== b);
  lt = this.cmp((a, b) => a < b);
  lte = this.cmp((a, b) => a <= b);
  gt = this.cmp((a, b) => a > b);
  gte = this.cmp((a, b) => a >= b);

  in(column: string, values: unknown[]) {
    const expected = values.map((v) => String(v));
    this.predicates.push((row) => {
      const actual = textOf(row, column);
      return actual !== NULL && expected.includes(actual);
    });
    return this;
  }

  is(column: string, value: null) {
    void value;
    this.predicates.push((row) => textOf(row, column) === NULL);
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    if (operator === 'is' && value === null) {
      this.predicates.push((row) => textOf(row, column) !== NULL);
      return this;
    }
    throw new Error(`fake-supa: unsupported not(${operator})`);
  }

  filter(column: string, operator: string, value: unknown) {
    if (operator !== 'cs') throw new Error(`fake-supa: unsupported filter ${operator}`);
    const target = JSON.parse(String(value)) as unknown[];
    this.predicates.push((row) => {
      const raw = rawOf(row, column);
      if (!Array.isArray(raw)) return false;
      return target.every((el) => raw.some((r) => deepEqual(r, el)));
    });
    return this;
  }

  order(column: string, options: { ascending: boolean }) {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  limit(count: number) {
    this.limitValue = count;
    return this;
  }

  private filteredRows(): FakeRow[] {
    const rows = this.fake.rows(this.table);
    return rows.filter((r) => this.predicates.every((p) => p(r)));
  }

  private execute(): QueryResult {
    const error = this.fake.errorFor(this.table);
    if (error) return { data: null, error: { message: error }, count: null };

    if (this.mode === 'update') {
      for (const row of this.filteredRows()) {
        Object.assign(row, this.updateValues ?? {});
      }
      return { data: null, error: null, count: null };
    }
    if (this.mode === 'delete') {
      const doomed = new Set(this.filteredRows());
      this.fake.replaceRows(
        this.table,
        this.fake.rows(this.table).filter((r) => !doomed.has(r)),
      );
      return { data: null, error: null, count: null };
    }

    let rows = this.filteredRows();
    if (this.countHead) {
      return { data: null, error: null, count: rows.length };
    }
    for (const spec of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const av = textOf(a, spec.column);
        const bv = textOf(b, spec.column);
        if (av === NULL && bv === NULL) return 0;
        // Postgres defaults: ASC nulls last, DESC nulls first.
        if (av === NULL) return spec.ascending ? 1 : -1;
        if (bv === NULL) return spec.ascending ? -1 : 1;
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        return spec.ascending ? c : -c;
      });
    }
    const cap = this.limitValue ?? MAX_ROWS;
    rows = rows.slice(0, cap);
    return {
      data: rows.map((r) => ({ id: r.id, data: r.data })),
      error: null,
      count: null,
    };
  }

  async maybeSingle(): Promise<QueryResult> {
    const error = this.fake.errorFor(this.table);
    if (error) return { data: null, error: { message: error }, count: null };
    const rows = this.filteredRows();
    if (rows.length === 0) return { data: null, error: null, count: null };
    if (rows.length > 1) {
      return {
        data: null,
        error: { message: 'JSON object requested, multiple (or no) rows returned' },
        count: null,
      };
    }
    const r = rows[0];
    return { data: { id: r.id, data: r.data }, error: null, count: null };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }
}

export class FakeSupa {
  private tables = new Map<string, FakeRow[]>();
  private errors = new Map<string, string>();

  seed(table: string, rows: FakeRow[]): this {
    this.tables.set(table, [...rows]);
    return this;
  }

  rows(table: string): FakeRow[] {
    return this.tables.get(table) ?? [];
  }

  replaceRows(table: string, rows: FakeRow[]): void {
    this.tables.set(table, rows);
  }

  setError(table: string, message: string | null): void {
    if (message) this.errors.set(table, message);
    else this.errors.delete(table);
  }

  errorFor(table: string): string | null {
    return this.errors.get(table) ?? null;
  }

  from(table: string) {
    const fake = this;
    return {
      select(_columns: string, options?: { count?: string; head?: boolean }) {
        return new FakeChain(
          fake,
          table,
          'select',
          options?.count === 'exact' && options?.head === true,
        );
      },
      upsert(row: Record<string, unknown>) {
        const error = fake.errorFor(table);
        const result: QueryResult = error
          ? { data: null, error: { message: error }, count: null }
          : { data: null, error: null, count: null };
        if (!error) {
          const rows = fake.rows(table);
          const idx = rows.findIndex((r) => r.id === row.id);
          const stored: FakeRow = {
            id: String(row.id),
            firebase_uid: (row.firebase_uid as string | null) ?? null,
            parent_path: (row.parent_path as string | null) ?? null,
            data: (row.data as Record<string, unknown>) ?? {},
          };
          if (idx >= 0) rows[idx] = stored;
          else rows.push(stored);
          fake.replaceRows(table, rows);
        }
        return Promise.resolve(result);
      },
      update(values: Record<string, unknown>) {
        return new FakeChain(fake, table, 'update', false, values);
      },
      delete() {
        return new FakeChain(fake, table, 'delete');
      },
    };
  }
}

/** Row builder matching the migration kit's landing shape. */
export function landingRow(
  id: string,
  data: Record<string, unknown>,
  parentPath: string | null = null,
  firebaseUid: string | null = null,
): FakeRow {
  return { id, firebase_uid: firebaseUid, parent_path: parentPath, data };
}

/** What the kit's dump actually stores for a Firestore Timestamp (measured). */
export function dumpedTimestamp(iso: string): { _seconds: number; _nanoseconds: number } {
  const ms = Date.parse(iso);
  return {
    _seconds: Math.floor(ms / 1000),
    _nanoseconds: (ms % 1000) * 1_000_000,
  };
}

/** A live Firestore-Timestamp-like value, as consumers hand to queries. */
export function liveTimestamp(iso: string): {
  toDate: () => Date;
  toMillis: () => number;
  seconds: number;
  nanoseconds: number;
} {
  const ms = Date.parse(iso);
  return {
    toDate: () => new Date(ms),
    toMillis: () => ms,
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
  };
}
