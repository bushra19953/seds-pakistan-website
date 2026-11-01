'use client';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { CatalogueSort } from '@/types/store-catalogue';

export interface FacetValues {
  q: string;
  inStock: boolean;
  minPrice: string;
  maxPrice: string;
  sort: CatalogueSort;
}

interface StoreSearchFacetsProps {
  values: FacetValues;
  onChange: (values: FacetValues) => void;
  onClear: () => void;
  showClear: boolean;
}

/** Search box plus facets for /store (PLAN-gd Section 5.2). Every
 *  control has a visible label bound by htmlFor; search is live, so
 *  the form never submits. */
export function StoreSearchFacets({ values, onChange, onClear, showClear }: StoreSearchFacetsProps) {
  const set = (patch: Partial<FacetValues>) => onChange({ ...values, ...patch });
  // Price fields accept only empty or whole numbers; anything else is
  // ignored so the last valid value stays in state.
  const setPrice = (key: 'minPrice' | 'maxPrice', raw: string) => {
    if (raw === '' || /^\d+$/.test(raw)) set({ [key]: raw } as Partial<FacetValues>);
  };

  return (
    <form role="search" onSubmit={(e) => e.preventDefault()} className="mb-8">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2 md:col-span-2 lg:col-span-4">
          <Label htmlFor="store-q">Search products</Label>
          <Input
            id="store-q"
            type="search"
            autoComplete="off"
            value={values.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        <div className="flex min-h-[44px] items-center gap-3">
          <Switch
            id="store-in-stock"
            checked={values.inStock}
            onCheckedChange={(checked) => set({ inStock: checked === true })}
          />
          <Label htmlFor="store-in-stock">In stock only</Label>
        </div>
        <div className="space-y-2">
          <Label htmlFor="store-min-price">Minimum price (PKR)</Label>
          <Input
            id="store-min-price"
            type="number"
            inputMode="numeric"
            min={0}
            value={values.minPrice}
            onChange={(e) => setPrice('minPrice', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="store-max-price">Maximum price (PKR)</Label>
          <Input
            id="store-max-price"
            type="number"
            inputMode="numeric"
            min={0}
            value={values.maxPrice}
            onChange={(e) => setPrice('maxPrice', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="store-sort">Sort by</Label>
          <Select value={values.sort} onValueChange={(v) => set({ sort: v as CatalogueSort })}>
            <SelectTrigger id="store-sort" className="min-h-[44px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="price_asc">Price: low to high</SelectItem>
              <SelectItem value="price_desc">Price: high to low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {showClear && (
        <Button type="button" variant="ghost" onClick={onClear} className="mt-2 min-h-[44px]">
          Clear filters
        </Button>
      )}
    </form>
  );
}
