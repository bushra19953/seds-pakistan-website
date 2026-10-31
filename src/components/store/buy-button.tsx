'use client';
import React from 'react';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useStoreTracking } from '@/lib/store/track';

interface BuyButtonProps {
  productId: string;
  label?: string;
  size?: 'default' | 'lg';
}

/** A real link to checkout that fires buy_click on click. The click
 *  never prevents navigation; firing is fire-and-forget. */
export function BuyButton({ productId, label = 'Buy now', size = 'lg' }: BuyButtonProps) {
  const { fireBuyClick } = useStoreTracking();
  return (
    <Button asChild size={size}>
      <Link
        href={`/checkout?productId=${productId}&type=product`}
        onClick={() => fireBuyClick(productId)}
      >
        {label}
      </Link>
    </Button>
  );
}
