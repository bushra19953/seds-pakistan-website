/**
 * @jest-environment node
 *
 * GA unit tests for the pure commission module (PLAN-ga Section 8.1,
 * spec 8.4). Fixtures only: round PKR amounts, no real data.
 */

import { computeCommission, roundHalfUp } from '@/lib/server/store-commission';

describe('roundHalfUp', () => {
  it('roundHalfUp rounds 0.5 up', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(100.5)).toBe(101);
  });

  it('roundHalfUp rounds below 0.5 down', () => {
    expect(roundHalfUp(0.49)).toBe(0);
    expect(roundHalfUp(100.49)).toBe(100);
  });

  it('roundHalfUp leaves integers unchanged', () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(7)).toBe(7);
    expect(roundHalfUp(10000)).toBe(10000);
  });
});

describe('computeCommission', () => {
  it('computeCommission takes 10 percent of the goods total', () => {
    expect(computeCommission(10000, 0.1)).toEqual({
      salePricePkr: 10000,
      commissionRate: 0.1,
      commissionPkr: 1000,
      vendorDuePkr: 9000,
    });
  });

  it('computeCommission rounds a half rupee up', () => {
    expect(computeCommission(1005, 0.1)).toEqual({
      salePricePkr: 1005,
      commissionRate: 0.1,
      commissionPkr: 101,
      vendorDuePkr: 904,
    });
    expect(computeCommission(995, 0.1)).toEqual({
      salePricePkr: 995,
      commissionRate: 0.1,
      commissionPkr: 100,
      vendorDuePkr: 895,
    });
  });

  it('computeCommission never touches delivery because delivery is not an input', () => {
    // Structural: the function takes exactly (subtotal, rate); there is
    // no delivery parameter a caller could pass by accident, and the
    // breakdown always sums back to the goods subtotal alone.
    expect(computeCommission.length).toBe(2);
    const breakdown = computeCommission(5000, 0.1);
    expect(breakdown.commissionPkr + breakdown.vendorDuePkr).toBe(breakdown.salePricePkr);
  });

  it('computeCommission at rate 0 gives zero commission', () => {
    expect(computeCommission(10000, 0)).toEqual({
      salePricePkr: 10000,
      commissionRate: 0,
      commissionPkr: 0,
      vendorDuePkr: 10000,
    });
  });

  it('computeCommission at rate 1 gives zero due', () => {
    expect(computeCommission(10000, 1)).toEqual({
      salePricePkr: 10000,
      commissionRate: 1,
      commissionPkr: 10000,
      vendorDuePkr: 0,
    });
  });

  it('computeCommission rejects a fractional subtotal', () => {
    expect(() => computeCommission(100.5, 0.1)).toThrow(RangeError);
  });

  it('computeCommission rejects a negative subtotal', () => {
    expect(() => computeCommission(-100, 0.1)).toThrow(RangeError);
  });

  it('computeCommission rejects a rate above 1', () => {
    expect(() => computeCommission(10000, 1.01)).toThrow(RangeError);
  });

  it('computeCommission rejects a negative rate', () => {
    expect(() => computeCommission(10000, -0.1)).toThrow(RangeError);
  });

  it('computeCommission rejects NaN inputs', () => {
    expect(() => computeCommission(Number.NaN, 0.1)).toThrow(RangeError);
    expect(() => computeCommission(10000, Number.NaN)).toThrow(RangeError);
  });
});
