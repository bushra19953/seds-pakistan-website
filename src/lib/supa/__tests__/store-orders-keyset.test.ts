/**
 * @jest-environment node
 *
 * PAGINATION CONTRACTS for the store-orders (createdAt, id) keyset
 * design (cutover-sections/store-design.md §1-§2).
 *
 * These tests PROVE the no-skip / no-duplicate property against the
 * reference implementation in src/lib/supa/store-orders-keyset.ts,
 * over an in-memory fake transport (a stand-in for the build wave's
 * rpc/adapter page fetcher — same call shape: page in, cursor out).
 * Zero live Firestore / Supabase. The build wave's production page
 * fetcher must pass these same properties; the datasets and page-size
 * sweeps here are the acceptance fixture for it.
 */

import {
  StoreOrdersCursorError,
  classifyStoreOrdersCursor,
  compareStoreOrderKeys,
  createdAtMillis,
  decodeStoreOrdersCursor,
  encodeStoreOrdersCursor,
  isAfterStoreOrderKey,
  keyFromLegacyCursorRow,
  keyOfStoreOrder,
  paginateStoreOrders,
  type StoreOrderKeysetRow,
} from '@/lib/supa/store-orders-keyset';

type Row = StoreOrderKeysetRow & { status: string };

const T = (day: number) => `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`;

/** Deterministic dataset: `groups` distinct timestamps x `perGroup` orders. */
function tiedDataset(groups: number, perGroup: number): Row[] {
  const rows: Row[] = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < perGroup; i++) {
      rows.push({
        id: `ord-g${g}-i${i}`,
        createdAt: T(g + 1),
        status: (g + i) % 3 === 0 ? 'verified' : 'pending_verification',
      });
    }
  }
  return rows;
}

/** Deterministic scramble (reverse + rotate) — insertion order must not matter. */
function scrambled<T>(rows: readonly T[]): T[] {
  const rev = [...rows].reverse();
  return rev.slice(7).concat(rev.slice(0, 7));
}

/** The expected full stream: the module's total order over keyable rows. */
function expectedOrder(rows: readonly Row[], statusFilter?: string | null): string[] {
  return paginateStoreOrders(rows, { limit: Number.MAX_SAFE_INTEGER, statusFilter }).items.map(
    (r) => r.id,
  );
}

/**
 * In-memory fake transport: stands in for the rpc/adapter fetcher.
 * Each fetch re-reads the CURRENT row array (so mid-pagination inserts
 * are visible to later fetches, exactly like a live backend) and runs
 * the reference pagination over it.
 */
function fakeTransport(getRows: () => Row[]) {
  return async (req: { limit: number; cursor: string | null; statusFilter?: string | null }) =>
    paginateStoreOrders(getRows(), req);
}

async function drainAll(
  fetchPage: ReturnType<typeof fakeTransport>,
  limit: number,
  statusFilter?: string | null,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await fetchPage({ limit, cursor, statusFilter });
    pages++;
    ids.push(...page.items.map((r) => r.id));
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      break;
    }
    expect(page.nextCursor).toBeTruthy();
    expect(page.items).toHaveLength(limit);
    cursor = page.nextCursor;
    if (pages > 10000) throw new Error('pagination did not terminate');
  }
  return { ids, pages };
}

/* ------------------------------------------------------------ key + order */

describe('createdAtMillis / keyOfStoreOrder', () => {
  const iso = '2026-03-05T10:20:30.123Z';
  const ms = Date.parse(iso);
  it('collapses every stored shape of the same instant to the same millis', () => {
    expect(createdAtMillis(iso)).toBe(ms);
    expect(createdAtMillis(new Date(ms))).toBe(ms);
    expect(createdAtMillis({ _seconds: Math.floor(ms / 1000), _nanoseconds: 123000000 })).toBe(ms);
    expect(createdAtMillis({ toMillis: () => ms })).toBe(ms);
    expect(createdAtMillis({ toDate: () => new Date(ms) })).toBe(ms);
    expect(createdAtMillis(ms)).toBe(ms);
  });
  it('null / missing / garbage -> null (row is outside the keyset universe)', () => {
    expect(createdAtMillis(null)).toBeNull();
    expect(createdAtMillis(undefined)).toBeNull();
    expect(createdAtMillis('not-a-date')).toBeNull();
    expect(createdAtMillis({})).toBeNull();
    expect(keyOfStoreOrder({ id: 'x' })).toBeNull();
    expect(keyOfStoreOrder({ id: 'x', createdAt: iso })).toEqual({ createdAtMillis: ms, id: 'x' });
  });
  it('sub-millisecond differences collapse — and the id tiebreak still orders them', () => {
    const a = { id: 'a', createdAt: { _seconds: 100, _nanoseconds: 500000000 } };
    const b = { id: 'b', createdAt: { _seconds: 100, _nanoseconds: 500400000 } }; // +0.4 ms
    expect(keyOfStoreOrder(a)!.createdAtMillis).toBe(keyOfStoreOrder(b)!.createdAtMillis);
    const page = paginateStoreOrders([b, a], { limit: 10 });
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('compareStoreOrderKeys / isAfterStoreOrderKey', () => {
  it('createdAt DESC, id ASC on ties', () => {
    const newer = { createdAtMillis: 200, id: 'zzz' };
    const older = { createdAtMillis: 100, id: 'aaa' };
    expect(compareStoreOrderKeys(newer, older)).toBeLessThan(0);
    expect(compareStoreOrderKeys(older, newer)).toBeGreaterThan(0);
    const tieA = { createdAtMillis: 100, id: 'a' };
    const tieB = { createdAtMillis: 100, id: 'b' };
    expect(compareStoreOrderKeys(tieA, tieB)).toBeLessThan(0);
    expect(compareStoreOrderKeys(tieA, tieA)).toBe(0);
  });
  it('after-predicate is strict and tie-aware', () => {
    const cursor = { createdAtMillis: 100, id: 'm' };
    expect(isAfterStoreOrderKey({ createdAtMillis: 99, id: 'a' }, cursor)).toBe(true);
    expect(isAfterStoreOrderKey({ createdAtMillis: 100, id: 'n' }, cursor)).toBe(true);
    expect(isAfterStoreOrderKey({ createdAtMillis: 100, id: 'm' }, cursor)).toBe(false);
    expect(isAfterStoreOrderKey({ createdAtMillis: 100, id: 'l' }, cursor)).toBe(false);
    expect(isAfterStoreOrderKey({ createdAtMillis: 101, id: 'a' }, cursor)).toBe(false);
  });
});

/* ------------------------------------------------------------ cursor codec */

describe('cursor encode/decode', () => {
  const key = { createdAtMillis: 1772664030123, id: 'ord-123' };
  it('round-trips and is opaque (no plaintext id / timestamp in the string)', () => {
    const cursor = encodeStoreOrdersCursor(key, 'verified');
    expect(cursor.startsWith('v1.')).toBe(true);
    expect(cursor).not.toContain('ord-123');
    expect(cursor).not.toContain('1772664030123');
    expect(decodeStoreOrdersCursor(cursor, 'verified')).toEqual({ ...key, statusFilter: 'verified' });
    expect(decodeStoreOrdersCursor(cursor)).toEqual({ ...key, statusFilter: 'verified' });
  });
  it("'all' and null normalize to the same filter component", () => {
    expect(decodeStoreOrdersCursor(encodeStoreOrdersCursor(key, 'all')).statusFilter).toBe('');
    expect(decodeStoreOrdersCursor(encodeStoreOrdersCursor(key, null)).statusFilter).toBe('');
    expect(decodeStoreOrdersCursor(encodeStoreOrdersCursor(key), null)).toBeTruthy();
    expect(decodeStoreOrdersCursor(encodeStoreOrdersCursor(key), 'all')).toBeTruthy();
  });
  it('filter mismatch is rejected, never silently applied', () => {
    const cursor = encodeStoreOrdersCursor(key, 'verified');
    expect(() => decodeStoreOrdersCursor(cursor, 'pending_verification')).toThrowError(
      expect.objectContaining({ code: 'filter-mismatch' }),
    );
    expect(() => paginateStoreOrders(tiedDataset(2, 2), { limit: 1, cursor, statusFilter: 'verified' })).not.toThrow();
  });
  it.each([
    ['v1.', 'malformed'],
    ['v1.!!!', 'malformed'],
    ['v1.aGVsbG8', 'malformed'], // base64url of "hello" — not JSON object payload
    ['v2.abc', 'unsupported-version'], // a newer cursor family: reject, never reinterpret
    ['bare-doc-id', 'malformed'],
    ['', 'malformed'],
  ])('rejects %j with code %s', (raw, code) => {
    expect(() => decodeStoreOrdersCursor(raw)).toThrowError(
      expect.objectContaining({ name: 'StoreOrdersCursorError', code }),
    );
    expect(new StoreOrdersCursorError('malformed', 'x')).toBeInstanceOf(Error);
  });
  it('rejects structurally valid JSON with wrong fields / version', () => {
    const mint = (obj: unknown) =>
      'v1.' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    expect(() => decodeStoreOrdersCursor(mint({ v: 2, c: 1, i: 'x', s: '' }))).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    );
    expect(() => decodeStoreOrdersCursor(mint({ v: 1, c: 'soon', i: 'x', s: '' }))).toThrowError(
      expect.objectContaining({ code: 'bad-payload' }),
    );
    expect(() => decodeStoreOrdersCursor(mint({ v: 1, c: 1.5, i: 'x', s: '' }))).toThrowError(
      expect.objectContaining({ code: 'bad-payload' }),
    );
    expect(() => decodeStoreOrdersCursor(mint({ v: 1, c: 1, i: '', s: '' }))).toThrowError(
      expect.objectContaining({ code: 'bad-payload' }),
    );
    expect(() => decodeStoreOrdersCursor(mint(['v', 1]))).toThrowError(
      expect.objectContaining({ code: 'bad-payload' }),
    );
  });
});

/* ------------------------------------------------------- legacy translation */

describe('legacy bare-id cursors', () => {
  it('classifies keyset vs legacy vs none', () => {
    expect(classifyStoreOrdersCursor(null)).toBe('none');
    expect(classifyStoreOrdersCursor('')).toBe('none');
    expect(classifyStoreOrdersCursor(encodeStoreOrdersCursor({ createdAtMillis: 1, id: 'x' }))).toBe('keyset');
    expect(classifyStoreOrdersCursor('v9.anything')).toBe('keyset'); // family: errors on decode, never legacy
    expect(classifyStoreOrdersCursor('AbC123xYzFirestoreAutoId')).toBe('legacy-id');
  });
  it('translation: key from the resolved row; ghost row -> null (caller rejects 400)', () => {
    expect(keyFromLegacyCursorRow({ id: 'o1', createdAt: T(3) })).toEqual({
      createdAtMillis: Date.parse(T(3)),
      id: 'o1',
    });
    expect(keyFromLegacyCursorRow(null)).toBeNull();
    expect(keyFromLegacyCursorRow({ id: 'o1' })).toBeNull();
  });
  it('REGRESSION (the original bug): a translated legacy cursor returns same-timestamp siblings the value bound skipped', async () => {
    // 3 orders share ONE timestamp; legacy cursor = the middle one in id order.
    const rows: Row[] = [
      { id: 'a1', createdAt: T(5), status: 'pending_verification' },
      { id: 'a2', createdAt: T(5), status: 'pending_verification' },
      { id: 'a3', createdAt: T(5), status: 'pending_verification' },
      { id: 'b1', createdAt: T(4), status: 'pending_verification' },
    ];
    // Old value-bound behavior would return ONLY b1 (a3 shares the bound value).
    const legacyKey = keyFromLegacyCursorRow(rows.find((r) => r.id === 'a2'))!;
    const cursor = encodeStoreOrdersCursor(legacyKey);
    const page = paginateStoreOrders(scrambled(rows), { limit: 10, cursor });
    expect(page.items.map((r) => r.id)).toEqual(['a3', 'b1']);
  });
});

/* ------------------------------------------------- no-skip / no-dupe proof */

describe('PROPERTY: paginating yields the full ordered set exactly once', () => {
  const datasets: Array<[string, Row[]]> = [
    ['60 orders, 6 timestamps x 10 ties', tiedDataset(6, 10)],
    ['50 orders, ALL sharing one timestamp', Array.from({ length: 50 }, (_, i) => ({
      id: `same-${String(i).padStart(2, '0')}`,
      createdAt: T(9),
      status: 'pending_verification' as const,
    }))],
    ['37 orders, distinct timestamps', Array.from({ length: 37 }, (_, i) => ({
      id: `dist-${String(i).padStart(2, '0')}`,
      createdAt: new Date(Date.parse(T(1)) + i * 61000).toISOString(),
      status: 'pending_verification' as const,
    }))],
    ['mixed timestamp shapes, same instants', tiedDataset(4, 5).map((r, i) =>
      i % 3 === 0
        ? { ...r, createdAt: new Date(Date.parse(r.createdAt as string)) }
        : i % 3 === 1
          ? {
              ...r,
              createdAt: {
                _seconds: Math.floor(Date.parse(r.createdAt as string) / 1000),
                _nanoseconds: 0,
              },
            }
          : r,
    )],
    ['empty', []],
    ['single row', [{ id: 'only', createdAt: T(2), status: 'pending_verification' }]],
  ];
  const pageSizes = [1, 2, 3, 5, 7, 20, 50, 100];

  for (const [name, dataset] of datasets) {
    for (const limit of pageSizes) {
      it(`${name} @ page size ${limit}`, async () => {
        const rows = scrambled(dataset);
        const { ids } = await drainAll(fakeTransport(() => rows), limit);
        const expected = expectedOrder(rows);
        expect(ids).toEqual(expected); // exact order, exact set
        expect(new Set(ids).size).toBe(ids.length); // no duplicates
        expect(ids).toHaveLength(expected.length); // no skips
      });
    }
  }

  it('same property under a status filter (filter applies before pagination)', async () => {
    const rows = scrambled(tiedDataset(8, 9)); // 72 rows, ~1/3 verified
    for (const limit of [1, 4, 9, 25]) {
      const { ids } = await drainAll(fakeTransport(() => rows), limit, 'verified');
      expect(ids).toEqual(expectedOrder(rows, 'verified'));
      expect(new Set(ids).size).toBe(ids.length);
      const unfiltered = await drainAll(fakeTransport(() => rows), limit);
      expect(unfiltered.ids).toEqual(expectedOrder(rows));
    }
  });

  it('rows without createdAt never enter or disturb the stream', async () => {
    const rows: Row[] = [
      ...tiedDataset(3, 4),
      { id: 'no-ts', createdAt: undefined, status: 'pending_verification' },
      { id: 'bad-ts', createdAt: 'junk', status: 'pending_verification' },
    ];
    const { ids } = await drainAll(fakeTransport(() => scrambled(rows)), 3);
    expect(ids).toEqual(expectedOrder(tiedDataset(3, 4)));
    expect(ids).not.toContain('no-ts');
  });

  it('limit must be a positive integer (the route clamps 1..50 before this)', () => {
    expect(() => paginateStoreOrders([], { limit: 0 })).toThrow(RangeError);
    expect(() => paginateStoreOrders([], { limit: 2.5 })).toThrow(RangeError);
  });
});

/* ------------------------------------------- inserts during pagination */

describe('PROPERTY: orders inserted mid-pagination', () => {
  it('no already-returned row repeats; not-yet-returned rows are never skipped', async () => {
    const base = tiedDataset(5, 6); // 30 rows
    const live: Row[] = [...base];
    const fetchPage = fakeTransport(() => scrambled(live));

    const p1 = await fetchPage({ limit: 7, cursor: null });
    const seen = p1.items.map((r) => r.id);
    expect(seen).toHaveLength(7);
    const cursorKey = decodeStoreOrdersCursor(p1.nextCursor!);

    // Insert AFTER page 1 was served:
    const newerThanCursor: Row = {
      id: 'zz-newer',
      createdAt: new Date(cursorKey.createdAtMillis + 60000).toISOString(), // sorts BEFORE cursor
      status: 'pending_verification',
    };
    const tieBeforeCursor: Row = {
      id: '00-tie-before', // same ts as cursor, smaller id -> sorts BEFORE cursor
      createdAt: new Date(cursorKey.createdAtMillis).toISOString(),
      status: 'pending_verification',
    };
    const tieAfterCursor: Row = {
      id: 'zz-tie-after', // same ts as cursor, larger id -> sorts AFTER cursor
      createdAt: new Date(cursorKey.createdAtMillis).toISOString(),
      status: 'pending_verification',
    };
    const olderThanCursor: Row = {
      id: 'zz-older',
      createdAt: new Date(cursorKey.createdAtMillis - 60000).toISOString(), // sorts AFTER cursor
      status: 'pending_verification',
    };
    live.push(newerThanCursor, tieBeforeCursor, tieAfterCursor, olderThanCursor);

    let cursor: string | null = p1.nextCursor;
    while (cursor) {
      const page = await fetchPage({ limit: 7, cursor });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    }

    // No duplicates anywhere across the whole walk.
    expect(new Set(seen).size).toBe(seen.length);
    // Every original row appears exactly once (nothing skipped by the inserts).
    for (const row of base) expect(seen.filter((id) => id === row.id)).toHaveLength(1);
    // Rows sorting at-or-before the page-1 cursor are NOT re-served later.
    expect(seen).not.toContain('zz-newer');
    expect(seen).not.toContain('00-tie-before');
    // Rows sorting strictly after the cursor may join the stream — exactly once.
    expect(seen.filter((id) => id === 'zz-tie-after')).toHaveLength(1);
    expect(seen.filter((id) => id === 'zz-older')).toHaveLength(1);
    expect(seen).toHaveLength(base.length + 2);
  });

  it('a fresh walk after inserts sees the inserted rows in total order', async () => {
    const rows = scrambled([
      ...tiedDataset(3, 3),
      { id: 'mid', createdAt: T(2), status: 'pending_verification' },
    ]);
    const { ids } = await drainAll(fakeTransport(() => rows), 4);
    expect(ids).toEqual(expectedOrder(rows));
  });
});
