/**
 * @jest-environment node
 *
 * Audit item 4: the shared server-side pricing rule
 * (src/lib/server/store-pricing.ts) used by BOTH order writers —
 * the checkout server action and the orders API route. The rule is
 * fail closed: every item is priced from the server-side product
 * record, a missing / inactive / unpriced product rejects the whole
 * order, and the client-claimed total is never the charged price.
 */

import {
  PriceVerificationError,
  coerceServerPrice,
  priceOrderServerSide,
  resolveServerUnitPrice,
  type ServerProductRecord,
} from '../store-pricing';

const catalog = new Map<string, ServerProductRecord>([
  ['p1', { exists: true, price: 500, isActive: true }],
  ['p2', { exists: true, price: 300, isActive: true }],
  ['inactive', { exists: true, price: 100, isActive: false }],
  ['unpriced', { exists: true, isActive: true }],
  ['string-priced', { exists: true, price: '250', isActive: true }],
]);

const lookup = async (pid: string): Promise<ServerProductRecord> =>
  catalog.get(pid) ?? { exists: false };

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('coerceServerPrice', () => {
  it('accepts finite non-negative numbers and numeric strings only', () => {
    expect(coerceServerPrice(500)).toBe(500);
    expect(coerceServerPrice(0)).toBe(0);
    expect(coerceServerPrice('250')).toBe(250);
    expect(coerceServerPrice(-1)).toBeNull();
    expect(coerceServerPrice(NaN)).toBeNull();
    expect(coerceServerPrice('abc')).toBeNull();
    expect(coerceServerPrice('')).toBeNull();
    expect(coerceServerPrice(null)).toBeNull();
    expect(coerceServerPrice(undefined)).toBeNull();
    expect(coerceServerPrice({})).toBeNull();
  });
});

describe('resolveServerUnitPrice', () => {
  it('returns the server price for an active priced product', async () => {
    await expect(resolveServerUnitPrice('p1', lookup)).resolves.toBe(500);
    await expect(resolveServerUnitPrice('string-priced', lookup)).resolves.toBe(250);
  });

  it('rejects a missing product (no trust-the-claim fallback)', async () => {
    await expect(resolveServerUnitPrice('ghost', lookup)).rejects.toBeInstanceOf(PriceVerificationError);
  });

  it('rejects an inactive product and an unpriced product', async () => {
    await expect(resolveServerUnitPrice('inactive', lookup)).rejects.toThrow(/not available/);
    await expect(resolveServerUnitPrice('unpriced', lookup)).rejects.toThrow(/no server-side price/);
  });

  it('uses the event-ticket resolver only for a missing/unpriced product, never for an inactive one', async () => {
    const resolver = jest.fn(async () => 500);
    await expect(resolveServerUnitPrice('ghost', lookup, resolver)).resolves.toBe(500);
    await expect(resolveServerUnitPrice('unpriced', lookup, resolver)).resolves.toBe(500);
    await expect(resolveServerUnitPrice('inactive', lookup, resolver)).rejects.toThrow(/not available/);
    await expect(resolveServerUnitPrice('p1', lookup, resolver)).resolves.toBe(500);
    expect(resolver).toHaveBeenCalledTimes(2); // ghost + unpriced only
  });
});

describe('priceOrderServerSide', () => {
  it('prices a single product from the server record; a matching claim passes', async () => {
    await expect(priceOrderServerSide({
      productId: 'p1', claimedTotal: 500, lookup,
    })).resolves.toBe(500);
  });

  it('a tampered claim is rejected — never charged at the client price', async () => {
    await expect(priceOrderServerSide({
      productId: 'p1', claimedTotal: 1, lookup,
    })).rejects.toThrow(/Price tampering detected/);
  });

  it('with no claim at all, the SERVER total is the price', async () => {
    await expect(priceOrderServerSide({
      productId: 'p1', claimedTotal: null, lookup,
    })).resolves.toBe(500);
  });

  it('an order referencing a missing product is rejected', async () => {
    await expect(priceOrderServerSide({
      productId: 'ghost', claimedTotal: 1, lookup,
    })).rejects.toBeInstanceOf(PriceVerificationError);
    await expect(priceOrderServerSide({
      items: [{ productId: 'ghost', quantity: 1 }], claimedTotal: 1, lookup,
    })).rejects.toBeInstanceOf(PriceVerificationError);
  });

  it('prices EVERY item in a multi-item order (quantities included)', async () => {
    await expect(priceOrderServerSide({
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 2 },
      ],
      claimedTotal: 1100,
      lookup,
    })).resolves.toBe(1100);
  });

  it('a multi-item order whose SECOND item is missing is rejected (not just priced on items[0])', async () => {
    await expect(priceOrderServerSide({
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'ghost', quantity: 1 },
      ],
      claimedTotal: 501,
      lookup,
    })).rejects.toBeInstanceOf(PriceVerificationError);
  });

  it('client-sent per-item prices are ignored: a tampered total claim against real items is rejected', async () => {
    await expect(priceOrderServerSide({
      items: [
        { productId: 'p1', quantity: 1, price: 1 } as never,
        { productId: 'p2', quantity: 1, price: 1 } as never,
      ],
      claimedTotal: 2,
      lookup,
    })).rejects.toThrow(/Price tampering detected/);
  });

  it('an item without a product reference is rejected', async () => {
    await expect(priceOrderServerSide({
      items: [{ quantity: 1 }], claimedTotal: 0, lookup,
    })).rejects.toBeInstanceOf(PriceVerificationError);
  });

  it('invalid quantities are rejected', async () => {
    await expect(priceOrderServerSide({
      items: [{ productId: 'p1', quantity: 0 }], claimedTotal: 0, lookup,
    })).rejects.toBeInstanceOf(PriceVerificationError);
    await expect(priceOrderServerSide({
      items: [{ productId: 'p1', quantity: -2 }], claimedTotal: -1000, lookup,
    })).rejects.toBeInstanceOf(PriceVerificationError);
  });

  it('the productId line uses its matching item quantity (orders-API single-product shape)', async () => {
    await expect(priceOrderServerSide({
      productId: 'p1',
      items: [{ productId: 'p1', quantity: 2 }],
      claimedTotal: 1000,
      lookup,
    })).resolves.toBe(1000);
  });

  it('an order referencing nothing at all is rejected without a fallback resolver', async () => {
    await expect(priceOrderServerSide({
      claimedTotal: 100, lookup,
    })).rejects.toThrow(/does not reference any product/);
  });

  it('an unreferenced (pure event-ticket) order is priced by the fallback resolver and claim-checked', async () => {
    await expect(priceOrderServerSide({
      claimedTotal: 500, lookup,
      resolveUnreferencedPrice: async () => 500,
    })).resolves.toBe(500);
    await expect(priceOrderServerSide({
      claimedTotal: 5, lookup,
      resolveUnreferencedPrice: async () => 500,
    })).rejects.toThrow(/Price tampering detected/);
    await expect(priceOrderServerSide({
      claimedTotal: 500, lookup,
      resolveUnreferencedPrice: async () => null,
    })).rejects.toBeInstanceOf(PriceVerificationError);
  });
});
