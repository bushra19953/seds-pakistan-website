/**
 * @jest-environment node
 *
 * GE SQL contract pins (PLAN-ge 11.5, as a NEW file per the program's
 * new-test-files-only rule): the tx_store_order_create amendment and
 * the deliberate non-change of tx_store_create_order.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (name: string) => readFileSync(join(__dirname, '../sql', name), 'utf8');

describe('GE tx_store_order_create amendment', () => {
  const sql = read('tx_store_order_create.sql');

  it('declares p_delivery_pkr with default 0, appended after p_items', () => {
    expect(sql).toContain('p_items jsonb default null,\n  p_delivery_pkr numeric default 0');
  });

  it('adds delivery into the verified total before the claim comparison', () => {
    const addIdx = sql.indexOf('v_total := v_total + coalesce(p_delivery_pkr, 0);');
    const claimIdx = sql.indexOf('p_claimed is null or p_claimed <> v_total');
    expect(addIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(addIdx);
  });

  it('tx_store_create_order.sql carries no delivery or repricing logic (leg asymmetry is intended)', () => {
    const other = read('tx_store_create_order.sql');
    expect(other).not.toContain('p_delivery_pkr');
    expect(other).not.toContain('deliveryPkr');
  });
});
