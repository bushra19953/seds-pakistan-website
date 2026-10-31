import React from 'react';
import type { CatalogueProduct } from '@/types/store-catalogue';
import { GroupBuyBlock } from './group-buy-block';

/** The reserved group-buy region on the product page. Renders
 *  nothing at all when the product is not group-buy eligible. */
export function GroupBuySlot({ product }: { product: CatalogueProduct }) {
  if (!product.groupBuyEligible) return null;
  return (
    <section aria-label="Group buying">
      <GroupBuyBlock
        productId={product.id}
        productName={product.name}
        unitPricePkr={product.price}
        teamSize={product.groupBuyTeamSize}
        windowHours={product.groupBuyWindowHours}
      />
    </section>
  );
}
