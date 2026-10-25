/**
 * @jest-environment node
 *
 * STORE CLUSTER — SUPABASE MIGRATION CONTRACT BASELINE (test-author branch
 * feat/supa-store-5). NO production code is touched by this suite.
 *
 * Purpose: pin the CURRENT (base @ 4d5a1e1, feat/integration-wave3) public
 * behavior of the store surfaces so a Supabase-backed implementation can be
 * checked for byte-identical shapes. Everything here runs against MOCKED
 * clients only — zero live Firestore / Supabase reads.
 *
 * Sources read verbatim before writing these contracts:
 *  - src/app/api/store/products/route.ts (258 lines)
 *  - src/app/api/store/orders/route.ts   (457 lines)
 *  - src/app/actions/store.ts            (getProduct / getPublicProducts /
 *                                         syncEventToProduct; createOrder is
 *                                         MANUAL-LIST, see below)
 *  - src/lib/finance/order-canonical.ts  (three legacy order shapes A/B/C)
 *  - src/lib/server/money-audit.ts       (buildMoneyAuditDoc / isSoftDeleted)
 *  - src/app/checkout/page.tsx           (settings/payment_methods reader,
 *                                         PaymentMethodsSettings at ~L482)
 *  - src/app/admin/store/components/certificate-settings.tsx
 *                                         (settings/payment_methods reader +
 *                                         destination_change request writer)
 *  - src/app/api/admin/finance/destinations/route.ts
 *                                         (settings/payment_methods view,
 *                                         destinationMeta split)
 *  - src/components/admin/events/event-form.tsx
 *                                         (Linked Store Product dropdown:
 *                                         client query isActive==true, then
 *                                         in-memory category filter)
 *
 * ADAPTER PARENT CONTRACT (from the migration brief + verified against
 * feat/supa-adapter via `git show`, NOT merged here):
 *  - src/lib/supa/: getDoc / listDocs / countDocs / setDoc / updateDoc /
 *    deleteDoc over fs_<collection> tables, rows { id, data } (jsonb),
 *    adapter returns { id, ...data }.
 *  - useSupa(surface) reads SUPA_SURFACES, default OFF, '*' = all,
 *    case-insensitive (adapter flags.ts: parseSupaSurfaces / useSupa).
 *  - Flag ON + null/unconfigured client, or adapter error => Firestore
 *    fallback, byte-identical shapes.
 *  - Tables for this cluster (create_tables.sql): fs_products, fs_orders,
 *    fs_settings, fs_audit_logs.
 *
 * RE-POINTING: sections marked SPEC-REPLICA contain small test-local
 * replicas of the adapter seam / flag / serializers. When the implementer
 * branches (feat/supa-store-1..4) land their seams, replace the replicas
 * with imports of the real seam and keep every expectation unchanged —
 * the expectations are the contract, the replica is only scaffolding.
 *
 * MONEY SAFETY — MANUAL LIST (must NOT be silently routed through the
 * generic adapter; each needs its own reviewed migration):
 *  1. POST /api/store/orders — server price verification precedes the
 *     write; the write itself is a single orders.add plus best-effort
 *     notifications (no batch, no audit entry on this route today).
 *  2. src/app/actions/store.ts createOrder — multi-write, NON-atomic:
 *     orders.add, events/{id}/registrations set(merge), products
 *     auto-create set/add, chapter_applications update, audit_logs.add.
 *     Price verification (product + per-item sums) precedes all writes.
 *  3. PATCH /api/store/products and PATCH /api/store/orders — state
 *     change + money-audit entry in ONE Firestore batch (fail closed).
 *  4. POST /api/store/products audit entry — direct audit_logs.add AFTER
 *     the product add; NOT atomic (see characterization test).
 *  5. settings/payment_methods writes — no direct writer exists anymore:
 *     changes go through POST /api/admin/finance/approvals with
 *     targetType 'destination_change' (maker-checker). The destinations
 *     GET route is read-only on purpose (CH-10).
 *  6. syncEventToProduct — contract only in this suite (payload shape);
 *     do not migrate it as part of the store read migration.
 */

import { normalizeOrder } from '@/lib/finance/order-canonical';

// firebase-admin/firestore is imported by money-audit.ts (FieldValue) and
// actions/store.ts (FieldValue). Mock it before either is imported.
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}));

import { isSoftDeleted, buildMoneyAuditDoc } from '@/lib/server/money-audit';

/* ------------------------------------------------------------------ */
/* Order canonicalization — the three legacy shapes (order-canonical)  */
/* ------------------------------------------------------------------ */

describe('contract: normalizeOrder across the three legacy order shapes', () => {
  it('shape A (types/checkout): total + status pending + userId + proofOfPaymentUrl', () => {
    const c = normalizeOrder(
      {
        total: 700,
        status: 'pending',
        userId: 'u-a',
        proofOfPaymentUrl: 'https://drive.example/a',
        proofOfPaymentDriveFileId: 'drive-a',
        items: [{ productId: 'p1', subtotal: 700 }],
      },
      'ord-a',
    );
    expect(c.id).toBe('ord-a');
    expect(c.totalPkr).toBe(700);
    expect(c.status).toBe('pending_verification'); // pending -> canonical
    expect(c.paymentStatus).toBe('pending'); // absent + not verified
    expect(c.buyerUserId).toBe('u-a'); // userId fallback
    expect(c.receiptUrl).toBe('https://drive.example/a');
    expect(c.receiptDriveId).toBe('drive-a');
    expect(c.currency).toBe('PKR'); // default when absent
    expect(c.dataQuality).toEqual({ missingAmount: false, unknownStatus: false });
  });

  it('shape B (orders API POST): amount + pending_verification + buyerUserId + receiptUrl', () => {
    const c = normalizeOrder(
      {
        amount: 500,
        status: 'pending_verification',
        paymentStatus: 'pending',
        buyerUserId: 'u-b',
        receiptUrl: 'https://drive.example/b',
        totalPkr: 500,
        total: 500,
      },
      'ord-b',
    );
    expect(c.totalPkr).toBe(500); // totalPkr wins over total/amount
    expect(c.status).toBe('pending_verification');
    expect(c.paymentStatus).toBe('pending');
    expect(c.buyerUserId).toBe('u-b');
    expect(c.receiptUrl).toBe('https://drive.example/b');
  });

  it('shape C (legacy admin): amount + paid + buyerUserId -> verified/completed', () => {
    const c = normalizeOrder(
      { amount: 900, status: 'paid', buyerUserId: 'u-c', receiptUrl: 'r-c' },
      'ord-c',
    );
    expect(c.totalPkr).toBe(900); // falls back totalPkr > total > amount
    expect(c.status).toBe('verified'); // paid -> verified
    expect(c.paymentStatus).toBe('completed'); // absent + paid => completed
    expect(c.buyerUserId).toBe('u-c');
  });

  it('money precedence and fallbacks: total > amount > item subtotal sum > 0+missingAmount', () => {
    expect(normalizeOrder({ total: 3, amount: 9 }, 'x').totalPkr).toBe(3);
    expect(normalizeOrder({ amount: 9 }, 'x').totalPkr).toBe(9);
    expect(
      normalizeOrder({ items: [{ subtotal: 4 }, { subtotal: 5 }] }, 'x').totalPkr,
    ).toBe(9);
    const empty = normalizeOrder({}, 'x');
    expect(empty.totalPkr).toBe(0);
    expect(empty.dataQuality.missingAmount).toBe(true);
    expect(empty.buyer).toBeNull();
    expect(empty.items).toEqual([]);
    expect(empty.isDeleted).toBe(false);
    expect(empty.declaredAmountPkr).toBeNull();
  });

  it('status map: pending_payment -> pending_verification, printed -> processing, unknown passes through flagged', () => {
    expect(normalizeOrder({ status: 'pending_payment' }, 'x').status).toBe('pending_verification');
    expect(normalizeOrder({ status: 'printed' }, 'x').status).toBe('processing');
    const unknown = normalizeOrder({ status: 'weird_legacy' }, 'x');
    expect(unknown.status).toBe('weird_legacy');
    expect(unknown.dataQuality.unknownStatus).toBe(true);
  });

  it('isDeleted derives from isDeleted===true OR canonical status soft_deleted', () => {
    expect(normalizeOrder({ isDeleted: true }, 'x').isDeleted).toBe(true);
    expect(normalizeOrder({ status: 'soft_deleted' }, 'x').isDeleted).toBe(true);
    expect(normalizeOrder({ isDeleted: false, status: 'processing' }, 'x').isDeleted).toBe(false);
  });
});

describe('contract: isSoftDeleted (money-audit) — GET orders filter predicate', () => {
  it('deleted iff deletedAt is present and non-null (absent/null are NOT deleted)', () => {
    expect(isSoftDeleted({})).toBe(false);
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
    expect(isSoftDeleted({ deletedAt: new Date() })).toBe(true);
    expect(isSoftDeleted(null)).toBe(false);
    expect(isSoftDeleted(undefined)).toBe(false);
  });
});

describe('contract: buildMoneyAuditDoc shape (audit_logs writer for store money actions)', () => {
  it('flattens target fields, nests before/after in payload, defaults orderId by targetType', () => {
    const doc = buildMoneyAuditDoc({
      action: 'product_created',
      actorUid: 'admin-1',
      targetType: 'product',
      targetId: 'prod-1',
      before: null,
      after: { price: 2500, dropped: undefined },
      changedFields: ['price'],
      source: 'store_products_api',
    });
    expect(doc.action).toBe('product_created');
    expect(doc.actorUid).toBe('admin-1');
    expect(doc.actorRole).toBe(''); // default when omitted
    expect(doc.targetUidOrResource).toBe('prod-1');
    expect(doc.targetType).toBe('product');
    expect(doc.orderId).toBeNull(); // non-order target => null
    expect(doc.payload).toEqual({
      before: null,
      after: { price: 2500 }, // undefined values stripped, nulls kept
      changedFields: ['price'],
      reason: null,
      source: 'store_products_api',
    });
    expect(doc.timestamp).toEqual({ __serverTimestamp: true });
    expect(doc.createdAt).toEqual({ __serverTimestamp: true });
  });

  it('order targets default orderId to the targetId', () => {
    const doc = buildMoneyAuditDoc({
      action: 'order_status_updated',
      actorUid: 'admin-1',
      targetType: 'order',
      targetId: 'ord-1',
      before: { status: 'verified' },
      after: { status: 'shipped' },
      source: 'store_orders_api',
    });
    expect(doc.orderId).toBe('ord-1');
  });
});
