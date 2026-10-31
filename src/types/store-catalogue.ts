/**
 * Public catalogue types for the vendor shop pilot (PLAN-gd Section 3.4).
 *
 * CatalogueProduct is the ONLY product shape that may reach a public
 * payload, page, or client component. It is built field by field by
 * toCatalogueProduct in src/lib/server/store-catalogue.ts. Admin fields
 * (cost, competitor, warehouse photos, audit fields, and every vendor
 * field other than businessName) are absent by construction.
 */

export type CatalogueSort = 'price_asc' | 'price_desc' | 'newest';

export interface CatalogueProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  stock: number;
  inStock: boolean;
  category: string;
  imageUrl: string | null;
  vendorId: string;
  businessName: string;
  deliveryChargePkr: number;
  dispatchWindowWorkingDays: number | null;
  deliveryPromiseDays: number | null;
  groupBuyEligible: boolean;
  groupBuyTeamSize: number | null;
  groupBuyWindowHours: number | null;
  createdAt: string | null;
}

/** Already validated query shape the catalogue route hands the helper. */
export interface CatalogueQuery {
  q?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  sort: CatalogueSort;
}

/** Spec Section 2.5 source enum, verbatim. */
export type WaitlistSource =
  | 'product_page_oos'
  | 'product_page_rail'
  | 'store_search_empty'
  | 'order_confirmation';

/** POST /api/store/waitlist body (PLAN-gd Section 7.2). */
export interface WaitlistCreateInput {
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  productId?: string;
  requestedText?: string;
  searchQuery?: string;
  source: WaitlistSource;
}
