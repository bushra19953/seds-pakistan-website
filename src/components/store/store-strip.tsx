'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ProductCard } from '@/components/store/product-card';
import { fetchCatalogue } from '@/lib/store/catalogue-client';
import type { CatalogueProduct } from '@/types/store-catalogue';

/**
 * Projects page store strip (PLAN-gd Section 10.2). A quiet
 * horizontal row so the projects grid stays the page's subject.
 * Renders nothing when the catalogue is empty or fails to load.
 */
export function StoreStrip() {
  const [products, setProducts] = useState<CatalogueProduct[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchCatalogue({}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setProducts(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed || products === null || products.length === 0) return null;

  return (
    <section aria-label="Store" className="mb-8">
      <h2 className="mb-4 text-xl font-semibold">Parts and tools for these builds</h2>
      <div className="flex gap-6 overflow-x-auto pb-4">
        {products.map((product) => (
          <div key={product.id} className="w-72 shrink-0">
            <ProductCard product={product} />
          </div>
        ))}
      </div>
      <Link href="/store" className="underline">
        Open the store
      </Link>
    </section>
  );
}

export default StoreStrip;
