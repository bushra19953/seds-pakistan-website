import type { CatalogueProduct, CatalogueSort } from '@/types/store-catalogue';

export interface CatalogueParams {
  q?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  sort?: CatalogueSort;
}

/** Browser read of the public catalogue. The only browser read path
 *  for products in GD surfaces; clients never read Firestore directly. */
export async function fetchCatalogue(
  params: CatalogueParams,
  signal?: AbortSignal,
): Promise<CatalogueProduct[]> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.inStock) search.set('inStock', 'true');
  if (params.minPrice !== undefined) search.set('minPrice', String(params.minPrice));
  if (params.maxPrice !== undefined) search.set('maxPrice', String(params.maxPrice));
  if (params.sort) search.set('sort', params.sort);
  const qs = search.toString();
  const res = await fetch(`/api/store/catalogue${qs ? `?${qs}` : ''}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (body && typeof body.error === 'string' && body.error) || 'The store could not load.',
    );
  }
  return Array.isArray(body?.products) ? (body.products as CatalogueProduct[]) : [];
}
