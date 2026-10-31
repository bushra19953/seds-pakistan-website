import React from 'react';
import type { CatalogueProduct } from '@/types/store-catalogue';
import { ProductCard } from './product-card';

interface AlternativesRailProps {
  products: CatalogueProduct[];
  label: string;
}

/** Same-vendor buyable alternatives (spec Section 4.3). Renders
 *  nothing at all when there are none. Rail cards are ordinary
 *  product cards; the destination page fires the clicked product's
 *  product_view, so no extra click handler lives here. */
export function AlternativesRail({ products, label }: AlternativesRailProps) {
  if (products.length === 0) return null;
  return (
    <section aria-label={label} className="mt-10">
      <h2 className="mb-4 text-xl font-semibold">{label}</h2>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}
