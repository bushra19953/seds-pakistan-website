'use client';

import React, { useEffect, useState } from 'react';
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
      <section aria-label="Store" className="container mx-auto px-4 py-20 md:py-32 md:px-6">
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
    <section aria-label="Store" className="container mx-auto px-4 py-20 md:py-32 md:px-6">
      <div className="text-center mb-12">
        <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">Store</h2>
        <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
          Parts and tools for your builds, priced in PKR.
        </p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 mb-12">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
      <div className="flex justify-center">
        <Button asChild variant="outline">
          <Link href="/store">Visit the store</Link>
        </Button>
      </div>
    </section>
  );
}

export default StoreSection;
