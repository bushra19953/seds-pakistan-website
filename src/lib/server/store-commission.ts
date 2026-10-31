/**
 * Vendor shop commission math (BUILD_SPEC Section 8.4).
 *
 * ONE pure implementation of the commission rule, shared by every
 * server caller that needs it: the verification hook's ledger accrual
 * (GG), payout drafting (GI), and vendor balance reads (GH). The rule:
 *
 *   commissionPkr = roundHalfUp(salePricePkr * commissionRate)
 *   vendorDuePkr  = salePricePkr - commissionPkr
 *
 * The base is salePricePkr, which is the order's subtotalPkr: goods
 * only. Delivery is never part of the input, and computeCommission
 * takes no delivery parameter so no caller can pass it by accident.
 *
 * Money is integer PKR everywhere in the store. Validation fails loud
 * in the store-pricing style: a fractional or negative subtotal, or a
 * rate outside [0, 1], throws RangeError instead of producing a
 * silently wrong split.
 *
 * computeLateDeliveryCreditPkr (spec 2.7) will be added to this same
 * file by GJ, which owns credit issuance. Do not create a second
 * money-math module.
 */

export interface CommissionBreakdown {
  salePricePkr: number;
  commissionRate: number;
  commissionPkr: number;
  vendorDuePkr: number;
}

/** Round half up for the non-negative values this domain allows: 0.5 goes up. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function computeCommission(salePricePkr: number, commissionRate: number): CommissionBreakdown {
  if (!Number.isInteger(salePricePkr) || salePricePkr < 0) {
    throw new RangeError(
      `computeCommission: salePricePkr must be a non-negative integer PKR amount, got ${salePricePkr}`,
    );
  }
  if (
    typeof commissionRate !== 'number' ||
    !Number.isFinite(commissionRate) ||
    commissionRate < 0 ||
    commissionRate > 1
  ) {
    throw new RangeError(
      `computeCommission: commissionRate must be a finite number in [0, 1], got ${commissionRate}`,
    );
  }
  const commissionPkr = roundHalfUp(salePricePkr * commissionRate);
  return {
    salePricePkr,
    commissionRate,
    commissionPkr,
    vendorDuePkr: salePricePkr - commissionPkr,
  };
}
