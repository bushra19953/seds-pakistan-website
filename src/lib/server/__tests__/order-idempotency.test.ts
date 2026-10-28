/**
 * @jest-environment node
 *
 * SEC-RACE (audit item 11): createOrderWithIdempotencyClaim — the
 * Firestore-leg dedupe behind the store checkout action and the
 * orders API. Two concurrent submissions carrying the same
 * (buyer, idempotencyKey) must produce exactly ONE order; the loser
 * is a replay returning the winner's orderId.
 *
 * The fake's runTransaction is serialized through a promise chain
 * (the fake-firestore.ts pattern), so concurrent claims interleave
 * like production Firestore transactions.
 */
import { createOrderWithIdempotencyClaim, orderIdempotencyClaimId } from '../order-idempotency';

function makeFakeDb() {
  const docs: Record<string, any> = {};
  let autoId = 0;
  let txChain: Promise<any> = Promise.resolve();

  function docRef(collectionName: string, id?: string): any {
    const docId = id ?? `auto-${++autoId}`;
    const path = `${collectionName}/${docId}`;
    return {
      id: docId,
      path,
      get: async () => {
        const data = docs[path];
        return { exists: data !== undefined, data: () => data };
      },
    };
  }

  const db = {
    collection: (name: string) => ({
      doc: (id?: string) => docRef(name, id),
      add: async (data: any) => {
        const ref = docRef(name);
        docs[ref.path] = { ...data };
        return ref;
      },
    }),
    runTransaction: (fn: any) => {
      const run = txChain.then(async () => {
        const tx = {
          get: async (ref: any) => ref.get(),
          set: async (ref: any, data: any) => {
            docs[ref.path] = { ...data };
          },
        };
        return fn(tx);
      });
      txChain = run.catch(() => undefined);
      return run;
    },
  };

  return {
    db,
    docs,
    orders: () => Object.entries(docs).filter(([p]) => p.startsWith('orders/')),
    claims: () => Object.entries(docs).filter(([p]) => p.startsWith('order_idempotency/')),
  };
}

const orderData = { total: 500, status: 'pending_verification', buyerUserId: 'buyer-1' };

describe('createOrderWithIdempotencyClaim (SEC-RACE item 11)', () => {
  test('two concurrent submissions with the same key create exactly one order', async () => {
    const { db, orders, claims } = makeFakeDb();
    const args = {
      buyerUid: 'buyer-1',
      idempotencyKey: 'attempt-abc',
      orderData,
      claimTimestamp: 'TS',
    };
    const [a, b] = await Promise.all([
      createOrderWithIdempotencyClaim(db as any, args),
      createOrderWithIdempotencyClaim(db as any, args),
    ]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.orderId).toBe(b.orderId);
    expect(orders()).toHaveLength(1);
    expect(claims()).toHaveLength(1);
    expect(claims()[0][0]).toBe(`order_idempotency/${orderIdempotencyClaimId('buyer-1', 'attempt-abc')}`);
    expect(claims()[0][1].orderId).toBe(a.orderId);
  });

  test('a sequential retry with the same key replays the original order', async () => {
    const { db, orders } = makeFakeDb();
    const args = { buyerUid: 'buyer-1', idempotencyKey: 'attempt-abc', orderData, claimTimestamp: 'TS' };
    const first = await createOrderWithIdempotencyClaim(db as any, args);
    const retry = await createOrderWithIdempotencyClaim(db as any, args);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.orderId).toBe(first.orderId);
    expect(orders()).toHaveLength(1);
  });

  test('different keys (a genuinely new purchase) create distinct orders', async () => {
    const { db, orders } = makeFakeDb();
    const a = await createOrderWithIdempotencyClaim(db as any, {
      buyerUid: 'buyer-1', idempotencyKey: 'attempt-1', orderData, claimTimestamp: 'TS',
    });
    const b = await createOrderWithIdempotencyClaim(db as any, {
      buyerUid: 'buyer-1', idempotencyKey: 'attempt-2', orderData, claimTimestamp: 'TS',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.orderId).not.toBe(b.orderId);
    expect(orders()).toHaveLength(2);
  });

  test('the same key under a different buyer is a different claim', async () => {
    const { db, orders } = makeFakeDb();
    const a = await createOrderWithIdempotencyClaim(db as any, {
      buyerUid: 'buyer-1', idempotencyKey: 'shared-key', orderData, claimTimestamp: 'TS',
    });
    const b = await createOrderWithIdempotencyClaim(db as any, {
      buyerUid: 'buyer-2', idempotencyKey: 'shared-key', orderData, claimTimestamp: 'TS',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(orders()).toHaveLength(2);
  });

  test('no key: plain add, unchanged legacy behavior', async () => {
    const { db, orders, claims } = makeFakeDb();
    const a = await createOrderWithIdempotencyClaim(db as any, {
      buyerUid: 'buyer-1', idempotencyKey: null, orderData, claimTimestamp: 'TS',
    });
    const b = await createOrderWithIdempotencyClaim(db as any, {
      buyerUid: 'buyer-1', idempotencyKey: undefined, orderData, claimTimestamp: 'TS',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.orderId).not.toBe(b.orderId);
    expect(orders()).toHaveLength(2);
    expect(claims()).toHaveLength(0);
  });
});
