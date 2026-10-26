/**
 * @jest-environment node
 *
 * S-W7 + SQL shape contracts for the store cutover pack
 * (src/lib/supa/sql/). The SQL is a flip-time APPLY artifact — it has
 * never executed against a real Postgres in this program (same
 * evidence limit the events/motions builds recorded) — so these pins
 * hold its CONTRACT SHAPE: function names match the tx() calls the TS
 * makes, the keyset predicate is the design's verbatim, the audit
 * writes are inside the same functions as the state writes, and the
 * idempotency index is the unique partial expression index of
 * design §3.5.3.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const sqlDir = join(__dirname, '..', 'sql');
const read = (name: string) => readFileSync(join(sqlDir, name), 'utf8');
/** Function body only: header comments legitimately discuss commits
 *  and decrements in prose; the pins below are about executable SQL. */
const body = (name: string) =>
  read(name)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const TX_FUNCTIONS = [
  'tx_store_product_create',
  'tx_store_product_update',
  'tx_store_product_delete',
  'tx_store_order_create',
  'tx_store_order_patch',
  'tx_store_create_order',
] as const;

describe('store SQL pack — function files', () => {
  for (const fn of TX_FUNCTIONS) {
    it(`${fn}.sql defines exactly that function via create or replace`, () => {
      const sql = read(`${fn}.sql`);
      expect(sql).toContain(`create or replace function ${fn}(`);
      expect(body(`${fn}.sql`)).not.toMatch(/\bdrop\b/i);
      expect(body(`${fn}.sql`)).not.toMatch(/\bcommit\b/i);
    });
  }

  it('every tx_store_* name the TS calls has a matching SQL file', () => {
    const tsSources = [
      readFileSync(join(__dirname, '..', 'store-orders.ts'), 'utf8'),
      readFileSync(join(__dirname, '..', 'store-products.ts'), 'utf8'),
      readFileSync(join(__dirname, '..', 'store-actions.ts'), 'utf8'),
    ].join('\n');
    const called = new Set([...tsSources.matchAll(/'(tx_store_[a-z_]+)'/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual([...TX_FUNCTIONS].sort());
  });

  it('product + order-patch functions write the audit row in the same function as the state write', () => {
    for (const fn of ['tx_store_product_create', 'tx_store_product_update', 'tx_store_product_delete', 'tx_store_order_patch']) {
      const sql = read(`${fn}.sql`);
      expect(sql).toContain('insert into fs_audit_logs');
    }
    expect(read('tx_store_product_update.sql')).toContain('for update');
    expect(read('tx_store_product_delete.sql')).toContain('for update');
    expect(read('tx_store_order_patch.sql')).toContain('for update');
  });

  it('order patch takes explicit scalars, never an arbitrary patch object (money-guard un-bypassable)', () => {
    const sql = read('tx_store_order_patch.sql');
    expect(sql).toContain('p_status text');
    expect(sql).toContain('p_fulfilment_note text');
    expect(sql).not.toMatch(/p_updates|p_patch\b/);
  });
});

describe('store SQL pack — keyset page function (S-K1)', () => {
  const sql = read('store_orders_page.sql');
  it('expresses the total order and the strict (millis,id) after-predicate verbatim', () => {
    expect(sql).toContain('create or replace function store_orders_page(');
    expect(sql).toContain('k.millis < p_cursor_millis');
    expect(sql).toContain('k.millis = p_cursor_millis and k.id > p_cursor_id');
    expect(sql).toContain('order by k.millis desc, k.id asc');
    expect(sql).toContain("r.data->>'status' = p_status");
  });
  it('is a read function (no writes)', () => {
    expect(sql).not.toMatch(/\binsert into\b|\bupdate fs_|\bdelete from\b/i);
  });
});

describe('store SQL pack — idempotency (S-W7, design §3.5)', () => {
  it('stages the unique PARTIAL (buyerUserId, idempotencyKey) index + the keyset page index as flip-time DDL', () => {
    const sql = read('store_keyset_indexes.sql');
    expect(sql).toContain('create unique index if not exists fs_orders_buyer_idempotency_key_idx');
    expect(sql).toContain("(data->>'buyerUserId'), (data->>'idempotencyKey')");
    expect(sql).toContain("where data->>'idempotencyKey' is not null");
    expect(sql).toContain('create index if not exists fs_orders_keyset_page_idx');
  });

  it('both order-create functions dedupe on (buyer, key), store the key, and convert the unique race', () => {
    for (const fn of ['tx_store_order_create', 'tx_store_create_order']) {
      const sql = read(`${fn}.sql`);
      expect(sql).toContain("data ->> 'buyerUserId'");
      expect(sql).toContain("data ->> 'idempotencyKey' = p_idempotency_key");
      expect(sql).toContain('unique_violation');
      expect(sql).toContain("'created', false");
    }
  });

  it('create_order commits registration + stub + audit in the same function (A1+A2+A3+A5)', () => {
    const sql = read('tx_store_create_order.sql');
    expect(sql).toContain('insert into fs_orders');
    expect(sql).toContain('insert into fs_group_registrations');
    expect(sql).toContain('insert into fs_products');
    expect(sql).toContain('insert into fs_audit_logs');
    expect(sql).toContain("'ORDER_CREATED'");
    // No stock decrement is invented anywhere in the pack (Q1 stands).
    expect(body('tx_store_create_order.sql')).not.toMatch(/stock[^;]*-[^;]*1|decrement/i);
  });
});

describe('store SQL pack — scope fences', () => {
  it("no store SQL implements finance's destination_change apply (S-W5 is finance-executed)", () => {
    for (const fn of TX_FUNCTIONS) {
      expect(read(`${fn}.sql`)).not.toContain('destination_change');
    }
    expect(read('store_orders_page.sql')).not.toContain('destination_change');
  });
  it('no store SQL writes fs_settings (store-settings has no store-owned write point)', () => {
    for (const fn of TX_FUNCTIONS) {
      expect(read(`${fn}.sql`)).not.toMatch(/insert into fs_settings|update fs_settings/);
    }
  });
});
