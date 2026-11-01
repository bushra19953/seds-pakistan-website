/**
 * listing-gate.ts: the vendor listing gates (BUILD_SPEC Section 3.2;
 * PLAN-gb Section 5.2; coordinator rulings R-5 and the GG naming
 * contract).
 *
 * Two layers, one checklist:
 *
 * 1. evaluateListingGate(product, vendor) is the pure predicate for
 *    in-process consumers (GD's catalogue, GG's Vendors tab). It
 *    returns { ok: true } or { ok: false, missing } with missing
 *    values from the planner set: 'vendor-inactive' | 'agreement' |
 *    'cost' | 'competitor' | 'priceRule', in checklist order. A null
 *    vendor (no record for the product's vendorId) reports
 *    'vendor-inactive'; the agreement check needs a record and is
 *    skipped when there is none.
 *
 * 2. evaluateVendorListingGates(db, mergedProduct) is the HTTP layer
 *    the products API enforces (CHOICE-GB-3): it reads the vendor doc
 *    once, runs the same predicate, and maps each missing value to
 *    the long gate name and final user-facing message used in the
 *    422 failedGates array. 'vendor-inactive' splits into
 *    vendor_not_found (no record) and vendor_not_active (record
 *    exists, status not active). An empty array means pass.
 *
 * Messages are final user-facing copy (no em dashes) and are shown
 * to the admin by name.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getVendorById, type VendorRecord } from '@/lib/server/vendor-access';

/** The product fields the gates read, in merged (stored + updates) form. */
export interface ListingGateProduct {
  vendorId?: string | null;
  costPricePkr?: unknown;
  competitorCheckedAt?: unknown;
  priceRule?: unknown;
  [key: string]: unknown;
}

/** The vendor fields the gates read. VendorRecord satisfies this. */
export interface ListingGateVendor {
  status?: string;
  agreementStatus?: string;
  [key: string]: unknown;
}

export type ListingGateMissing =
  | 'vendor-inactive'
  | 'agreement'
  | 'cost'
  | 'competitor'
  | 'priceRule';

export type ListingGateResult =
  | { ok: true }
  | { ok: false; missing: ListingGateMissing[] };

export function evaluateListingGate(
  product: ListingGateProduct,
  vendor: ListingGateVendor | null | undefined,
): ListingGateResult {
  const missing: ListingGateMissing[] = [];

  if (!vendor || vendor.status !== 'active') {
    missing.push('vendor-inactive');
  }
  if (vendor && vendor.agreementStatus !== 'signed') {
    missing.push('agreement');
  }

  const cost = product.costPricePkr;
  if (typeof cost !== 'number' || Number.isNaN(cost) || cost <= 0) {
    missing.push('cost');
  }

  if (product.competitorCheckedAt === null || product.competitorCheckedAt === undefined) {
    missing.push('competitor');
  }

  const rule = product.priceRule;
  if (rule === null || rule === undefined || rule === '') {
    missing.push('priceRule');
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

export interface ListingGateFailure {
  gate: string;
  message: string;
}

const FAILURE_BY_MISSING: Record<Exclude<ListingGateMissing, 'vendor-inactive'>, ListingGateFailure> = {
  agreement: {
    gate: 'agreement_not_signed',
    message: 'Listing gate failed: vendor agreement is not signed',
  },
  cost: {
    gate: 'cost_price_missing',
    message: 'Listing gate failed: cost price is missing',
  },
  competitor: {
    gate: 'competitor_check_missing',
    message: 'Listing gate failed: competitor price check is missing',
  },
  priceRule: {
    gate: 'price_rule_missing',
    message: 'Listing gate failed: price rule is missing',
  },
};

export async function evaluateVendorListingGates(
  db: Firestore,
  mergedProduct: ListingGateProduct,
): Promise<ListingGateFailure[]> {
  const vendorId = typeof mergedProduct.vendorId === 'string' ? mergedProduct.vendorId : '';
  const vendor: VendorRecord | null = vendorId ? await getVendorById(db, vendorId) : null;

  const result = evaluateListingGate(mergedProduct, vendor);
  if (result.ok) return [];

  return result.missing.map((m) => {
    if (m === 'vendor-inactive') {
      return vendor
        ? { gate: 'vendor_not_active', message: 'Listing gate failed: vendor is not active' }
        : { gate: 'vendor_not_found', message: 'Listing gate failed: vendor record not found' };
    }
    return FAILURE_BY_MISSING[m];
  });
}
