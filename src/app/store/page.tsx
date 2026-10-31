'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import PageHero from '@/components/ui/page-hero';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductCard } from '@/components/store/product-card';
import { StoreSearchFacets, type FacetValues } from '@/components/store/store-search-facets';
import { WaitlistForm } from '@/components/store/waitlist-form';
import { fetchCatalogue, type CatalogueParams } from '@/lib/store/catalogue-client';
import type { CatalogueProduct, CatalogueSort } from '@/types/store-catalogue';

const DEFAULT_FACETS: FacetValues = {
  q: '',
  inStock: false,
  minPrice: '',
  maxPrice: '',
  sort: 'newest',
};

function StoreGridSkeleton() {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {[...Array(6)].map((_, i) => (
        <Skeleton key={i} className="h-80 w-full" />
      ))}
    </div>
  );
}

function parsePrice(raw: string): number | undefined {
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function StorePageInner() {
  const searchParams = useSearchParams();
  const [facets, setFacets] = useState<FacetValues>(() => {
    const sortParam = searchParams.get('sort');
    return {
      q: searchParams.get('q') || '',
      inStock: searchParams.get('inStock') === 'true',
      minPrice: searchParams.get('minPrice') || '',
      maxPrice: searchParams.get('maxPrice') || '',
      sort: (['price_asc', 'price_desc', 'newest'].includes(sortParam || '')
        ? sortParam
        : 'newest') as CatalogueSort,
    };
  });
  const [debouncedQ, setDebouncedQ] = useState(facets.q);
  const [products, setProducts] = useState<CatalogueProduct[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(facets.q), 300);
    return () => clearTimeout(timer);
  }, [facets.q]);

  useEffect(() => {
    const controller = new AbortController();
    const params: CatalogueParams = {
      q: debouncedQ.trim() || undefined,
      inStock: facets.inStock || undefined,
      minPrice: parsePrice(facets.minPrice),
      maxPrice: parsePrice(facets.maxPrice),
      sort: facets.sort,
    };
    setLoading(true);
    fetchCatalogue(params, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setProducts(result);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedQ, facets.inStock, facets.minPrice, facets.maxPrice, facets.sort, reloadKey]);

  const filtersActive =
    facets.q.trim() !== '' ||
    facets.inStock ||
    facets.minPrice !== '' ||
    facets.maxPrice !== '' ||
    facets.sort !== 'newest';
  const showClear = filtersActive;

  const clearFilters = () => setFacets(DEFAULT_FACETS);

  return (
    <div className="min-h-screen">
      <PageHero title="Store" subtitle="Parts and tools for your builds, priced in PKR." />
      <main className="container mx-auto px-4 py-10 md:px-6">
        <StoreSearchFacets
          values={facets}
          onChange={setFacets}
          onClear={clearFilters}
          showClear={showClear}
        />

        {error ? (
          <Alert role="alert">
            <AlertDescription className="flex flex-wrap items-center gap-4">
              <span>The store could not load. Please try again.</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => setReloadKey((k) => k + 1)}
                className="min-h-[44px]"
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : products === null ? (
          <StoreGridSkeleton />
        ) : (
          <div aria-busy={loading}>
            <p aria-live="polite" className="mb-4 text-sm text-muted-foreground">
              {products.length} {products.length === 1 ? 'product' : 'products'}
            </p>
            {products.length > 0 ? (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
            ) : filtersActive ? (
              <div className="max-w-xl space-y-4">
                <h2 className="text-xl font-semibold">No products match your search</h2>
                <p className="text-muted-foreground">
                  {debouncedQ.trim()
                    ? `We do not have "${debouncedQ.trim()}" right now.`
                    : 'No products match these filters.'}{' '}
                  Tell us what you are looking for and we will contact you if it becomes
                  available.
                </p>
                <WaitlistForm
                  key={`search-${debouncedQ.trim()}`}
                  source="store_search_empty"
                  initialRequestedText={debouncedQ.trim()}
                  searchQuery={debouncedQ.trim() || null}
                />
              </div>
            ) : (
              <div className="max-w-xl space-y-4">
                <h2 className="text-xl font-semibold">The store is not open yet</h2>
                <p className="text-muted-foreground">
                  No products are listed right now. Tell us what you are looking for and we
                  will contact you if it becomes available.
                </p>
                <WaitlistForm
                  key="catalogue-empty"
                  source="store_search_empty"
                  initialRequestedText=""
                  searchQuery={null}
                />
              </div>
            )}
          </div>
        )}

        <p className="mt-12 text-sm">
          <Link href="/store/returns" className="underline">
            Returns policy
          </Link>
        </p>
      </main>
    </div>
  );
}

export default function StorePage() {
  return (
    <Suspense fallback={<StoreGridSkeleton />}>
      <StorePageInner />
    </Suspense>
  );
}
