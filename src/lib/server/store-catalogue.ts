/**
 * store-catalogue.ts: the public read path for the vendor shop pilot
 * (PLAN-gd Sections 3 and 4). Server only, Admin SDK only.
 *
 * toCatalogueProduct is the single projection from a raw product doc
 * to the public CatalogueProduct shape. It builds a fresh object field
 * by field; spreading the raw doc is forbidden here, because product
 * docs carry admin fields (cost, competitor, warehouse photos, audit
 * fields) that must never reach a public payload (test P5).
 *
 * Vendor gate (spec Section 4.2 plus coordinator ruling R-14): a
 * product is public only when its vendor is status 'active' AND its
 * agreementStatus is 'signed'. House products (vendorId null or
 * absent) are never public through this path.
 *
 * Read budget per call:
 * - queryCatalogue: 1 vendors query + 1 products query (capped at
 *   1000 docs), all filtering and sorting in memory. No per-product
 *   vendor fetch anywhere.
 * - getCatalogueProduct: 1 product get + 1 vendor get.
 * - listAlternatives: 1 products query scoped to the one vendor.
 * - getPilotSellerName: 1 vendors query.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { CatalogueProduct, CatalogueQuery } from '@/types/store-catalogue';

type DocData = Record<string, any>;

function asNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as any).toDate === 'function') {
    try {
      return (value as any).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

export function toCatalogueProduct(id: string, data: DocData, businessName: string): CatalogueProduct {
  const stock = asNumber(data.stock, 0) as number;
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : '',
    price: asNumber(data.price, 0) as number,
    currency: typeof data.currency === 'string' ? data.currency : 'PKR',
    stock,
    inStock: stock > 0,
    category: typeof data.category === 'string' ? data.category : '',
    imageUrl: typeof data.imageUrl === 'string' && data.imageUrl ? data.imageUrl : null,
    vendorId: typeof data.vendorId === 'string' ? data.vendorId : '',
    businessName,
    deliveryChargePkr: asNumber(data.deliveryChargePkr, 0) as number,
    dispatchWindowWorkingDays: asNumber(data.dispatchWindowWorkingDays, null),
    deliveryPromiseDays: asNumber(data.deliveryPromiseDays, null),
    groupBuyEligible: data.groupBuyEligible === true,
    groupBuyTeamSize: asNumber(data.groupBuyTeamSize, null),
    groupBuyWindowHours: asNumber(data.groupBuyWindowHours, null),
    createdAt: toIsoString(data.createdAt),
  };
}

/**
 * Vendor doc ids that may sell publicly, mapped to businessName.
 * One query on vendors where status == 'active'; the agreement check
 * (R-14) runs in memory on those docs, so the read count stays 1.
 */
export async function loadActiveVendorMap(db: Firestore): Promise<Map<string, string>> {
  const snap = await db.collection('vendors').where('status', '==', 'active').get();
  const map = new Map<string, string>();
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.agreementStatus !== 'signed') continue;
    map.set(doc.id, typeof data.businessName === 'string' ? data.businessName : '');
  }
  return map;
}

function compareProducts(a: CatalogueProduct, b: CatalogueProduct, sort: CatalogueQuery['sort']): number {
  if (sort === 'price_asc' || sort === 'price_desc') {
    const byPrice = sort === 'price_asc' ? a.price - b.price : b.price - a.price;
    if (byPrice !== 0) return byPrice;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  }
  // newest: createdAt descending, missing timestamps last, id breaks ties.
  if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.createdAt && !b.createdAt) return -1;
  if (!a.createdAt && b.createdAt) return 1;
  return a.id.localeCompare(b.id);
}

export async function queryCatalogue(db: Firestore, params: CatalogueQuery): Promise<CatalogueProduct[]> {
  const vendorMap = await loadActiveVendorMap(db);
  if (vendorMap.size === 0) return [];

  const productsSnap = await db.collection('products').where('isActive', '==', true).limit(1000).get();
  let products: CatalogueProduct[] = [];
  for (const doc of productsSnap.docs) {
    const data = doc.data();
    const vendorId = typeof data.vendorId === 'string' ? data.vendorId : '';
    if (!vendorId || !vendorMap.has(vendorId)) continue;
    products.push(toCatalogueProduct(doc.id, data, vendorMap.get(vendorId) as string));
  }

  if (params.q) {
    const needle = params.q.toLowerCase();
    products = products.filter(
      (p) => p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle),
    );
  }
  // inStock false (or absent) keeps every product; only true filters.
  if (params.inStock === true) products = products.filter((p) => p.stock > 0);
  if (params.minPrice !== undefined) products = products.filter((p) => p.price >= (params.minPrice as number));
  if (params.maxPrice !== undefined) products = products.filter((p) => p.price <= (params.maxPrice as number));

  products.sort((a, b) => compareProducts(a, b, params.sort));
  return products;
}

export async function getCatalogueProduct(db: Firestore, productId: string): Promise<CatalogueProduct | null> {
  const productSnap = await db.collection('products').doc(productId).get();
  if (!productSnap.exists) return null;
  const data = productSnap.data() as DocData;
  if (data.isActive !== true) return null;
  const vendorId = typeof data.vendorId === 'string' ? data.vendorId : '';
  if (!vendorId) return null;

  const vendorSnap = await db.collection('vendors').doc(vendorId).get();
  if (!vendorSnap.exists) return null;
  const vendor = vendorSnap.data() as DocData;
  if (vendor.status !== 'active' || vendor.agreementStatus !== 'signed') return null;

  const businessName = typeof vendor.businessName === 'string' ? vendor.businessName : '';
  return toCatalogueProduct(productSnap.id, data, businessName);
}

/**
 * Spec Section 4.3 alternatives: same vendor, category electronics,
 * in stock, not the product itself. Cheapest first, at most 4.
 */
export async function listAlternatives(db: Firestore, product: CatalogueProduct): Promise<CatalogueProduct[]> {
  const snap = await db
    .collection('products')
    .where('vendorId', '==', product.vendorId)
    .where('isActive', '==', true)
    .get();
  const alternatives: CatalogueProduct[] = [];
  for (const doc of snap.docs) {
    if (doc.id === product.id) continue;
    const data = doc.data();
    if (data.category !== 'electronics') continue;
    if (!(typeof data.stock === 'number' && data.stock > 0)) continue;
    alternatives.push(toCatalogueProduct(doc.id, data, product.businessName));
  }
  alternatives.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  return alternatives.slice(0, 4);
}

/**
 * The pilot seller name for the returns page: the first active vendor
 * with a signed agreement, or null when none exists yet (the shipped
 * configured-empty state). One vendors query.
 */
export async function getPilotSellerName(db: Firestore): Promise<string | null> {
  const vendorMap = await loadActiveVendorMap(db);
  for (const businessName of vendorMap.values()) {
    if (businessName) return businessName;
  }
  return null;
}
