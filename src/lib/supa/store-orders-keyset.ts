/**
 * Store orders (createdAt, id) KEYSET pagination — pure module.
 *
 * Design: ~/workspace/supabase-migration/cutover-sections/store-design.md §1.
 * This module is NEW, isolated and flag-free: nothing imports it yet.
 * The build wave wires it into src/lib/supa/store-orders.ts and the
 * orders route behind SUPA_PRIMARY 'store-orders-api'; until then the
 * live value-bound cursor in store-orders.ts is unchanged.
 *
 * THE TOTAL ORDER (the whole design rests on this one definition):
 *
 *   sort by createdAt DESC, then by document id ASC.
 *
 * That is exactly the order the two existing backends already produce:
 * Firestore `orderBy('createdAt','desc')` breaks timestamp ties by
 * document name ascending, and the Supabase adapter's client-side
 * finishing (adapter.ts listDocs) negates the orderBy comparison for
 * 'desc' and then applies "document id, ascending" as its final
 * tiebreak (its G4/G7 rule). So this keyset changes NO visible ordering
 * — it only makes the cursor address one row in that order instead of
 * one timestamp value.
 *
 * A row's key is a deterministic pure function of the row:
 *
 *   key(row) = { createdAtMillis(row.createdAt), row.id }
 *
 * createdAtMillis collapses every stored timestamp shape (ISO string,
 * Date, Timestamp-like, dumped {_seconds,_nanoseconds}) to integer
 * milliseconds — the same conversion isoOrNull() in the store seams
 * performs. Two instants that differ only below 1 ms collapse to the
 * same millis; that is SAFE, because they then tie on the first key
 * component and the unique id component still orders them. No proof
 * step below needs distinct timestamps — only a total order and a
 * strict "after" predicate, both of which the (millis, id) pair gives.
 *
 * Cursor format (opaque, versioned):
 *
 *   "v1." + base64url( JSON { v: 1, c: <millis int>, i: <id>, s: <filter> } )
 *
 * `s` is the normalized status filter the cursor was minted under
 * ('' for none / 'all'); a cursor presented under a different filter
 * is rejected, never silently applied to a different stream. The
 * cursor is NOT signed: it carries no authority (the caller already
 * passed the canManageStore gate) and its decoded values are used
 * only as range bounds, so a forged cursor can only page the caller's
 * own authorized list oddly — it cannot widen access.
 *
 * Legacy cursors: the pre-keyset API used the bare document id as the
 * cursor. classifyStoreOrdersCursor() distinguishes the two, and the
 * seam translates a legacy id by resolving the document and minting
 * its key (keyFromLegacyCursorRow + encodeStoreOrdersCursor). See the
 * design report §1.5 for the translate-vs-reject decision.
 */

/* ------------------------------------------------------------------ types */

export interface StoreOrderKey {
  /** Integer milliseconds since epoch, from createdAtMillis(). */
  createdAtMillis: number;
  /** Firestore document id. Unique per order — the tiebreak component. */
  id: string;
}

/** Structural minimum of an order row this module needs. */
export interface StoreOrderKeysetRow {
  id: string;
  createdAt?: unknown;
  status?: unknown;
  [field: string]: unknown;
}

export type StoreOrdersCursorErrorCode =
  | 'malformed'
  | 'unsupported-version'
  | 'filter-mismatch'
  | 'bad-payload';

export class StoreOrdersCursorError extends Error {
  readonly code: StoreOrdersCursorErrorCode;
  constructor(code: StoreOrdersCursorErrorCode, message: string) {
    super(message);
    this.name = 'StoreOrdersCursorError';
    this.code = code;
  }
}

/* ------------------------------------------------------- timestamp -> ms */

/**
 * Milliseconds for any timestamp shape the store data holds, else null.
 * Mirrors the conversion contract of the store seams (isoOrNull) and of
 * adapter.timestampMillis: ISO strings parse, Date / toMillis() /
 * toDate() use their instant, the dumped {_seconds,_nanoseconds} shape
 * floors sub-millisecond residue (isoOrNull does the same).
 */
export function createdAtMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.floor(value) : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v._seconds === 'number' && typeof v._nanoseconds === 'number') {
      if (!Number.isFinite(v._seconds) || !Number.isFinite(v._nanoseconds)) return null;
      return v._seconds * 1000 + Math.floor(v._nanoseconds / 1e6);
    }
    if (typeof v.toMillis === 'function') {
      try {
        const ms = (v.toMillis as () => number)();
        return Number.isFinite(ms) ? Math.floor(ms) : null;
      } catch {
        return null;
      }
    }
    if (typeof v.toDate === 'function') {
      try {
        const ms = (v.toDate as () => Date)().getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The key of a row, or null when the row has no usable createdAt. */
export function keyOfStoreOrder(row: StoreOrderKeysetRow): StoreOrderKey | null {
  const ms = createdAtMillis(row.createdAt);
  if (ms === null || typeof row.id !== 'string' || row.id.length === 0) return null;
  return { createdAtMillis: ms, id: row.id };
}

/* ------------------------------------------------------------- total order */

/**
 * The total order: createdAt DESC, id ASC.
 * Negative = a comes first, positive = b comes first, 0 = same key
 * (possible only for the same document: ids are unique).
 */
export function compareStoreOrderKeys(a: StoreOrderKey, b: StoreOrderKey): number {
  if (a.createdAtMillis !== b.createdAtMillis) {
    return a.createdAtMillis > b.createdAtMillis ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Strict keyset predicate: does `key` sort strictly AFTER `cursor` in
 * the total order? For (createdAt DESC, id ASC) that is:
 *   createdAtMillis <  cursor.createdAtMillis, OR
 *   createdAtMillis == cursor.createdAtMillis AND id > cursor.id.
 * This predicate — never an offset, never a bare value bound — is what
 * the SQL / adapter query in the build wave must express verbatim.
 */
export function isAfterStoreOrderKey(key: StoreOrderKey, cursor: StoreOrderKey): boolean {
  return compareStoreOrderKeys(key, cursor) > 0;
}

/* --------------------------------------------------------- cursor encoding */

/** Normalized filter component stored in the cursor ('' = no filter). */
export function normalizeStatusFilter(statusFilter: string | null | undefined): string {
  if (!statusFilter || statusFilter === 'all') return '';
  return statusFilter;
}

const CURSOR_PREFIX = 'v1.';

function base64UrlEncode(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new StoreOrdersCursorError('malformed', 'cursor payload is not base64url');
  }
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** Mint the opaque cursor pointing AT `key` (the last row of a page). */
export function encodeStoreOrdersCursor(
  key: StoreOrderKey,
  statusFilter?: string | null,
): string {
  const payload = {
    v: 1,
    c: key.createdAtMillis,
    i: key.id,
    s: normalizeStatusFilter(statusFilter),
  };
  return CURSOR_PREFIX + base64UrlEncode(JSON.stringify(payload));
}

/**
 * Parse and validate a v1 cursor. When `expectedStatusFilter` is given
 * (the filter on the current request), a cursor minted under another
 * filter throws 'filter-mismatch'. Throws StoreOrdersCursorError on
 * every invalid input — callers map it to HTTP 400 invalid_cursor.
 */
export function decodeStoreOrdersCursor(
  raw: string,
  expectedStatusFilter?: string | null,
): StoreOrderKey & { statusFilter: string } {
  if (typeof raw !== 'string' || !raw.startsWith(CURSOR_PREFIX)) {
    if (typeof raw === 'string' && /^v\d+\./.test(raw)) {
      throw new StoreOrdersCursorError(
        'unsupported-version',
        'store-orders cursor version is newer than this server understands',
      );
    }
    throw new StoreOrdersCursorError('malformed', 'not a v1 store-orders cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw.slice(CURSOR_PREFIX.length)));
  } catch (err) {
    if (err instanceof StoreOrdersCursorError) throw err;
    throw new StoreOrdersCursorError('malformed', 'cursor payload is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreOrdersCursorError('bad-payload', 'cursor payload is not an object');
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) {
    throw new StoreOrdersCursorError(
      'unsupported-version',
      `unsupported store-orders cursor version: ${String(p.v)}`,
    );
  }
  if (
    typeof p.c !== 'number' ||
    !Number.isSafeInteger(p.c) ||
    typeof p.i !== 'string' ||
    p.i.length === 0 ||
    p.i.length > 256 ||
    typeof p.s !== 'string'
  ) {
    throw new StoreOrdersCursorError('bad-payload', 'cursor payload fields are invalid');
  }
  if (
    expectedStatusFilter !== undefined &&
    p.s !== normalizeStatusFilter(expectedStatusFilter)
  ) {
    throw new StoreOrdersCursorError(
      'filter-mismatch',
      'cursor was minted under a different status filter; restart pagination without a cursor',
    );
  }
  return { createdAtMillis: p.c, id: p.i, statusFilter: p.s };
}

/**
 * Which cursor family is this string?
 *  - 'keyset':    v1. (or a future vN.) prefixed — decode it; a string
 *                 in this family that fails to decode is an ERROR, it
 *                 is never reinterpreted as a legacy id.
 *  - 'legacy-id': anything else — the pre-keyset bare document id.
 * Firestore order ids in this app are minted by collection.add()
 * (auto-ids, no '.'), so the reserved prefix cannot collide with a
 * real legacy cursor in practice.
 */
export function classifyStoreOrdersCursor(
  raw: string | null | undefined,
): 'none' | 'keyset' | 'legacy-id' {
  if (!raw) return 'none';
  if (/^v\d+\./.test(raw)) return 'keyset';
  return 'legacy-id';
}

/**
 * Translate a legacy bare-id cursor: given the resolved cursor row
 * (the seam fetches it by id, exactly as store-orders.ts does today),
 * return its key. null = the document does not exist / has no usable
 * createdAt — the caller rejects with 400 invalid_cursor (design §1.5;
 * the old "ignore a ghost cursor" behavior is deliberately retired).
 */
export function keyFromLegacyCursorRow(
  row: StoreOrderKeysetRow | null | undefined,
): StoreOrderKey | null {
  if (!row) return null;
  return keyOfStoreOrder(row);
}

/* ------------------------------------------------- reference pagination */

/**
 * REFERENCE IMPLEMENTATION of the keyset page semantics — the build
 * wave's SQL/rpc (or adapter) implementation must be observably
 * identical to this function over the same row set:
 *
 *   1. status filter (equality, skipped for null/'all') — as today,
 *      the filter applies BEFORE ordering/pagination (Firestore where).
 *   2. rows with no usable createdAt are outside the keyset universe
 *      (Firestore orderBy excludes docs missing the ordered field;
 *      both order-create paths always stamp createdAt — design §1.6).
 *   3. sort by the total order; keep rows strictly after the cursor.
 *   4. take limit rows; hasMore iff more rows remain; nextCursor is
 *      the key of the last returned row (null when hasMore is false).
 *
 * The route's in-code soft-delete filter stays a POST-filter on the
 * returned page, exactly as today (characterized behavior, unchanged
 * by this design).
 */
export function paginateStoreOrders<T extends StoreOrderKeysetRow>(
  rows: readonly T[],
  options: {
    limit: number;
    cursor?: string | null;
    statusFilter?: string | null;
  },
): { items: T[]; hasMore: boolean; nextCursor: string | null } {
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`paginateStoreOrders: limit must be a positive integer, got ${limit}`);
  }
  const statusFilter = normalizeStatusFilter(options.statusFilter);
  const cursorKey = options.cursor
    ? decodeStoreOrdersCursor(options.cursor, statusFilter)
    : null;

  const keyed: Array<{ row: T; key: StoreOrderKey }> = [];
  for (const row of rows) {
    if (statusFilter && row.status !== statusFilter) continue;
    const key = keyOfStoreOrder(row);
    if (!key) continue;
    if (cursorKey && !isAfterStoreOrderKey(key, cursorKey)) continue;
    keyed.push({ row, key });
  }
  keyed.sort((a, b) => compareStoreOrderKeys(a.key, b.key));

  const hasMore = keyed.length > limit;
  const page = hasMore ? keyed.slice(0, limit) : keyed;
  return {
    items: page.map((p) => p.row),
    hasMore,
    nextCursor: hasMore
      ? encodeStoreOrdersCursor(page[page.length - 1].key, statusFilter)
      : null,
  };
}
