'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductCard } from '@/components/store/product-card';
import { fetchCatalogue } from '@/lib/store/catalogue-client';
import type { CatalogueProduct } from '@/types/store-catalogue';

/**
 * Homepage Store block (PLAN-gd Section 10.1). Renders nothing when
 * the catalogue is empty or fails to load: the shipped homepage
 * carries no empty store shell, and the block appears by itself when
 * the first product lists.
 */
export function StoreSection() {
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

  if (failed) return null;
  if (products === null) {
    return (
      <section aria-label="Store" className="container mx-auto px-4 py-10 md:px-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-80 w-full" />
          ))}
        </div>
      </section>
    );
  }
  if (products.length === 0) return null;

  return (
    <section aria-label="Store" className="container mx-auto px-4 py-10 md:px-6">
      <h2 className="text-2xl font-bold">Store</h2>
      <p className="mt-2 text-muted-foreground">
        Parts and tools for your builds, priced in PKR.
      </p>
      <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
      <div className="mt-6">
        <Button asChild variant="outline">
          <Link href="/store">Visit the store</Link>
        </Button>
      </div>
    </section>
  );
}

export default StoreSection;
