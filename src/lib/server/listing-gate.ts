/**
 * listing-gate.ts: the vendor listing gates (BUILD_SPEC Section 3.2;
 * PLAN-gb Section 5.2; coordinator ruling R-5: GB owns this module,
 * the products API enforces it at one choke point above the primacy
 * branch, and consumers import it rather than re-checking fields).
 *
 * evaluateListingGate reads the vendor doc once and returns EVERY
 * failure, in the fixed checklist order below; an empty array means
 * the listing may go live. Messages are final user-facing copy (no
 * em dashes) and are shown to the admin by name.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getVendorById } from '@/lib/server/vendor-access';

export interface ListingGateFailure {
  gate: string;
  message: string;
}

/** The product fields the gates read, in merged (stored + updates) form. */
export interface ListingGateProduct {
  vendorId?: string | null;
  costPricePkr?: unknown;
  competitorCheckedAt?: unknown;
  priceRule?: unknown;
  [key: string]: unknown;
}

export async function evaluateListingGate(
  db: Firestore,
  mergedProduct: ListingGateProduct,
): Promise<ListingGateFailure[]> {
  const failures: ListingGateFailure[] = [];
  const vendorId = typeof mergedProduct.vendorId === 'string' ? mergedProduct.vendorId : '';
  const vendor = vendorId ? await getVendorById(db, vendorId) : null;

  if (!vendor) {
    failures.push({
      gate: 'vendor_not_found',
      message: 'Listing gate failed: vendor record not found',
    });
    // Gates 2 and 3 read the vendor doc; with no doc they are skipped.
    // Gates 4 to 6 still run against the product fields.
  } else {
    if (vendor.status !== 'active') {
      failures.push({
        gate: 'vendor_not_active',
        message: 'Listing gate failed: vendor is not active',
      });
    }
    if (vendor.agreementStatus !== 'signed') {
      failures.push({
        gate: 'agreement_not_signed',
        message: 'Listing gate failed: vendor agreement is not signed',
      });
    }
  }

  const cost = mergedProduct.costPricePkr;
  if (typeof cost !== 'number' || Number.isNaN(cost) || cost <= 0) {
    failures.push({
      gate: 'cost_price_missing',
      message: 'Listing gate failed: cost price is missing',
    });
  }

  if (mergedProduct.competitorCheckedAt === null || mergedProduct.competitorCheckedAt === undefined) {
    failures.push({
      gate: 'competitor_check_missing',
      message: 'Listing gate failed: competitor price check is missing',
    });
  }

  const rule = mergedProduct.priceRule;
  if (rule === null || rule === undefined || rule === '') {
    failures.push({
      gate: 'price_rule_missing',
      message: 'Listing gate failed: price rule is missing',
    });
  }

  return failures;
}
