/**
 * @jest-environment node
 *
 * Unit tests for the Item 7 money-audit helpers
 * (src/lib/server/money-audit.ts, spec section (f) suite 3).
 */

import {
  buildMoneyAuditDoc,
  deriveOrderAuditAction,
  isSoftDeleted,
  sanitizeAuditValue,
} from '@/lib/server/money-audit';

describe('buildMoneyAuditDoc (Item 7)', () => {
  it('builds the full (c) field set for an order action', () => {
    const doc = buildMoneyAuditDoc({
      action: 'order_payment_verified',
      actorUid: 'admin-1',
      actorRole: 'store_admin',
      targetType: 'order',
      targetId: 'order-1',
      before: { status: 'pending_verification', paymentStatus: null },
      after: { status: 'verified', paymentStatus: null },
      changedFields: ['status'],
      reason: null,
      source: 'store_orders_api',
    });

    expect(doc.action).toBe('order_payment_verified');
    expect(doc.actorUid).toBe('admin-1');
    expect(doc.actorRole).toBe('store_admin');
    expect(doc.targetUidOrResource).toBe('order-1');
    expect(doc.targetType).toBe('order');
    expect(doc.orderId).toBe('order-1');
    const payload = doc.payload as any;
    expect(payload.before).toEqual({ status: 'pending_verification', paymentStatus: null });
    expect(payload.after).toEqual({ status: 'verified', paymentStatus: null });
    expect(payload.changedFields).toEqual(['status']);
    expect(payload.reason).toBeNull();
    expect(payload.source).toBe('store_orders_api');
    // timestamp and createdAt are the same server-timestamp sentinel.
    expect(doc.timestamp).toBeDefined();
    expect(doc.createdAt).toBe(doc.timestamp);
  });

  it('builds the full (c) field set for a product action (orderId null)', () => {
    const doc = buildMoneyAuditDoc({
      action: 'product_updated',
      actorUid: 'admin-1',
      actorRole: 'store_admin',
      targetType: 'product',
      targetId: 'prod-1',
      before: { price: 100 },
      after: { price: 150 },
      changedFields: ['price'],
      reason: null,
      source: 'store_products_api',
    });

    expect(doc.targetType).toBe('product');
    expect(doc.targetUidOrResource).toBe('prod-1');
    expect(doc.orderId).toBeNull();
    expect((doc.payload as any).before).toEqual({ price: 100 });
    expect((doc.payload as any).after).toEqual({ price: 150 });
  });

  it('builds the full (c) field set for a settings action', () => {
    const doc = buildMoneyAuditDoc({
      action: 'payment_settings_updated',
      actorUid: 'admin-1',
      actorRole: 'superadmin',
      targetType: 'settings',
      targetId: 'payments',
      before: { easypaisa: { accountNumber: '0300' } },
      after: { easypaisa: { accountNumber: '0311' } },
      changedFields: ['payments'],
      reason: null,
      source: 'site_settings_api',
    });

    expect(doc.targetType).toBe('settings');
    expect(doc.orderId).toBeNull();
    expect(doc.actorRole).toBe('superadmin');
  });

  it('strips undefined values from before/after but keeps nulls', () => {
    const doc = buildMoneyAuditDoc({
      action: 'order_updated',
      actorUid: 'a',
      targetType: 'order',
      targetId: 'o-1',
      before: { status: 'pending', note: undefined, ref: null },
      after: { status: undefined, ref: null },
      source: 'store_orders_api',
    });

    const payload = doc.payload as any;
    expect(payload.before).toEqual({ status: 'pending', ref: null });
    expect('note' in payload.before).toBe(false);
    expect(payload.after).toEqual({ ref: null });
  });

  it('defaults actorRole to empty string and changedFields to []', () => {
    const doc = buildMoneyAuditDoc({
      action: 'order_updated',
      actorUid: 'a',
      targetType: 'order',
      targetId: 'o-1',
      before: null,
      after: null,
      source: 's',
    });
    expect(doc.actorRole).toBe('');
    expect((doc.payload as any).changedFields).toEqual([]);
  });
});

describe('deriveOrderAuditAction precedence (Item 7)', () => {
  it('refunded wins over everything', () => {
    expect(
      deriveOrderAuditAction({ paymentStatus: 'refunded', status: 'verified' })
    ).toBe('order_refunded');
  });
  it('status verified beats paymentStatus completed', () => {
    expect(
      deriveOrderAuditAction({ status: 'verified', paymentStatus: 'completed' })
    ).toBe('order_payment_verified');
  });
  it('paymentStatus completed alone is order_marked_paid', () => {
    expect(deriveOrderAuditAction({ paymentStatus: 'completed' })).toBe(
      'order_marked_paid'
    );
  });
  it('any other status change is order_status_updated', () => {
    expect(deriveOrderAuditAction({ status: 'shipped' })).toBe('order_status_updated');
  });
  it('no status/paymentStatus is order_updated', () => {
    expect(deriveOrderAuditAction({ notes: 'x' })).toBe('order_updated');
    expect(deriveOrderAuditAction(null)).toBe('order_updated');
    expect(deriveOrderAuditAction(undefined)).toBe('order_updated');
  });
});

describe('sanitizeAuditValue / isSoftDeleted (Item 7)', () => {
  it('sanitize keeps nulls, drops undefined, recurses into arrays', () => {
    expect(sanitizeAuditValue({ a: undefined, b: null, c: [1, undefined, { d: undefined, e: 2 }] }))
      .toEqual({ b: null, c: [1, { e: 2 }] });
  });
  it('isSoftDeleted is true only when deletedAt is set', () => {
    expect(isSoftDeleted({ deletedAt: new Date() })).toBe(true);
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
    expect(isSoftDeleted({})).toBe(false);
    expect(isSoftDeleted(null)).toBe(false);
    expect(isSoftDeleted(undefined)).toBe(false);
  });
});
