/**
 * @jest-environment node
 *
 * S-K1 ACCEPTANCE FIXTURE: the §2 keyset property suite re-pointed at
 * the PRODUCTION fetcher — getStoreOrdersPageFromSupa over a fake
 * adapter whose rpc('store_orders_page') implements the SQL predicate
 * with the keyset module (the semantics src/lib/supa/sql/
 * store_orders_page.sql expresses). Concatenated pages must equal
 * paginateStoreOrders' full ordered set exactly, in order, with no
 * duplicates — the same datasets and page sizes as
 * store-orders-keyset.test.ts (design §2).
 */

import {
  compareStoreOrderKeys,
  encodeStoreOrdersCursor,
  isAfterStoreOrderKey,
  keyOfStoreOrder,
  paginateStoreOrders,
  type StoreOrderKeysetRow,
} from '@/lib/supa/store-orders-keyset';

const mockState = {
  orders: [] as Array<StoreOrderKeysetRow>,
  rpcCalls: [] as Array<[string, any]>,
};

jest.mock('@/lib/supa', () => ({
  useSupa: jest.fn(() => true),
  getSupaClient: jest.fn(() => ({})),
  getSupaAdapter: jest.fn(() => ({
    getDoc: jest.fn(async (_collection: string, id: string) => {
      const found = mockState.orders.find((r) => r.id === id);
      return found ? { ...found } : null;
    }),
    listDocs: jest.fn(async () => []),
    rpc: jest.fn(async (fn: string, args: any) => {
      mockState.rpcCalls.push([fn, args]);
      if (fn !== 'store_orders_page') throw new Error(`unexpected rpc: ${fn}`);
      let rows = mockState.orders.filter((r) => keyOfStoreOrder(r) !== null);
      if (args.p_status) rows = rows.filter((r) => r.status === args.p_status);
      if (args.p_cursor_millis != null) {
        const cursorKey = { createdAtMillis: args.p_cursor_millis, id: args.p_cursor_id };
        rows = rows.filter((r) => isAfterStoreOrderKey(keyOfStoreOrder(r)!, cursorKey));
      }
      rows.sort((a, b) => compareStoreOrderKeys(keyOfStoreOrder(a)!, keyOfStoreOrder(b)!));
      return rows.slice(0, args.p_limit).map((r) => {
        const { id, ...data } = r;
        return { id, data };
      });
    }),
  })),
}));

import { getStoreOrdersPageFromSupa } from '@/lib/supa/store-orders';

type Row = StoreOrderKeysetRow;

const T = (day: number) => `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`;

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

function scrambled(rows: readonly Row[]): Row[] {
  const rev = [...rows].reverse();
  return rev.slice(7).concat(rev.slice(0, 7));
}

/** Drain the seam exactly as the route does (no soft-deleted rows here). */
async function drain(limit: number, statusFilter: string | null = null): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10000; guard++) {
    const page = (await getStoreOrdersPageFromSupa({ limit, cursor, statusFilter })) as any;
    expect(page).not.toBeNull();
    expect(page.invalidCursor).toBeUndefined();
    const fetched = page.fetched as Array<{ id: string; raw: Row }>;
    const hasMore = fetched.length > limit;
    const returned = hasMore ? fetched.slice(0, limit) : fetched;
    ids.push(...returned.map((r) => r.id));
    if (!hasMore) return ids;
    const last = returned[returned.length - 1];
    const key = keyOfStoreOrder({ id: last.id, createdAt: last.raw.createdAt });
    expect(key).not.toBeNull();
    cursor = encodeStoreOrdersCursor(key!, statusFilter);
  }
  throw new Error('pagination did not terminate');
}

function expectedIds(rows: readonly Row[], statusFilter: string | null = null): string[] {
  return paginateStoreOrders(
    rows.map((r) => ({ ...r, status: r.status as string })),
    { limit: Number.MAX_SAFE_INTEGER, statusFilter },
  ).items.map((r) => r.id);
}

const datasets: Array<[string, Row[]]> = [
  ['60 orders = 6 timestamps x 10 ties', tiedDataset(6, 10)],
  ['50 orders sharing ONE timestamp', Array.from({ length: 50 }, (_, i) => ({
    id: `same-${String(i).padStart(2, '0')}`, createdAt: T(9), status: 'verified',
  }))],
  ['37 distinct timestamps', Array.from({ length: 37 }, (_, i) => ({
    id: `d-${String(i).padStart(2, '0')}`,
    createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 61000).toISOString(),
    status: 'pending_verification',
  }))],
  ['mixed timestamp shapes of the same instants', [
    { id: 'm1', createdAt: '2026-03-05T10:20:30.123Z', status: 'verified' },
    { id: 'm2', createdAt: new Date('2026-03-05T10:20:30.123Z'), status: 'verified' },
    { id: 'm3', createdAt: { _seconds: 1772706030, _nanoseconds: 123000000 }, status: 'verified' },
    { id: 'm4', createdAt: '2026-03-04T00:00:00.000Z', status: 'verified' },
  ]],
  ['empty', []],
  ['single row', [{ id: 'only', createdAt: T(1), status: 'verified' }]],
];

describe('S-K1: production keyset fetcher reproduces paginateStoreOrders', () => {
  for (const [name, rows] of datasets) {
    for (const pageSize of [1, 2, 3, 5, 7, 20, 50, 100]) {
      it(`${name} @ pageSize ${pageSize}: exact ordered union, no duplicates`, async () => {
        mockState.orders = scrambled(rows);
        const ids = await drain(pageSize);
        expect(ids).toEqual(expectedIds(rows));
        expect(new Set(ids).size).toBe(ids.length);
      });
    }
    it(`${name} under a status filter: exact ordered union`, async () => {
      mockState.orders = scrambled(rows);
      const ids = await drain(3, 'verified');
      expect(ids).toEqual(expectedIds(rows, 'verified'));
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('mid-pagination inserts: before/at-cursor inserts never shift or repeat; after-cursor inserts appear exactly once', async () => {
    const base = tiedDataset(3, 4); // 12 rows, timestamps T1..T3
    mockState.orders = scrambled(base);
    const limit = 5;
    const page1 = (await getStoreOrdersPageFromSupa({ limit, cursor: null, statusFilter: null })) as any;
    const firstIds = page1.fetched.slice(0, limit).map((f: any) => f.id);
    const lastKey = keyOfStoreOrder({
      id: page1.fetched[limit - 1].id,
      createdAt: page1.fetched[limit - 1].raw.createdAt,
    })!;
    const cursor = encodeStoreOrdersCursor(lastKey, null);
    // Insert: one newer (sorts before cursor), one same-millis smaller
    // id (at-or-before cursor), one same-millis larger id (after).
    mockState.orders.push(
      { id: 'ins-newer', createdAt: '2026-03-09T00:00:00.000Z', status: 'pending_verification' },
      { id: 'a-ins-before', createdAt: new Date(lastKey.createdAtMillis).toISOString(), status: 'pending_verification' },
      { id: 'z-ins-after', createdAt: new Date(lastKey.createdAtMillis).toISOString(), status: 'pending_verification' },
    );
    const rest: string[] = [];
    let cur: string | null = cursor;
    for (let guard = 0; guard < 100; guard++) {
      const page = (await getStoreOrdersPageFromSupa({ limit, cursor: cur, statusFilter: null })) as any;
      const fetched = page.fetched as Array<any>;
      const hasMore = fetched.length > limit;
      const returned = hasMore ? fetched.slice(0, limit) : fetched;
      rest.push(...returned.map((r: any) => r.id));
      if (!hasMore) break;
      const last = returned[returned.length - 1];
      cur = encodeStoreOrdersCursor(keyOfStoreOrder({ id: last.id, createdAt: last.raw.createdAt })!, null);
    }
    const walked = [...firstIds, ...rest];
    // No repeats, no pre-existing row skipped; the after-cursor insert
    // appears exactly once; before/at inserts never appear.
    expect(new Set(walked).size).toBe(walked.length);
    for (const row of base) expect(walked).toContain(row.id);
    expect(walked.filter((id) => id === 'z-ins-after')).toHaveLength(1);
    expect(walked).not.toContain('ins-newer');
    expect(walked).not.toContain('a-ins-before');
  });

  it('filter-mismatch: a cursor minted under one filter is rejected, never applied to another stream', async () => {
    mockState.orders = tiedDataset(2, 3);
    const cursor = encodeStoreOrdersCursor({ createdAtMillis: Date.parse(T(2)), id: 'ord-g1-i0' }, null);
    const res = await getStoreOrdersPageFromSupa({ limit: 5, cursor, statusFilter: 'verified' });
    expect(res).toEqual({ invalidCursor: true, code: 'filter-mismatch' });
  });

  it('malformed / unsupported-version keyset cursors are rejected as invalidCursor', async () => {
    mockState.orders = tiedDataset(1, 2);
    await expect(getStoreOrdersPageFromSupa({ limit: 5, cursor: 'v1.!!!not-base64!!!', statusFilter: null }))
      .resolves.toEqual({ invalidCursor: true, code: 'malformed' });
    await expect(getStoreOrdersPageFromSupa({ limit: 5, cursor: 'v9.abc', statusFilter: null }))
      .resolves.toEqual({ invalidCursor: true, code: 'unsupported-version' });
  });
});
