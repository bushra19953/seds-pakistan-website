'use client';
import React from 'react';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useStoreTracking } from '@/lib/store/track';

interface BuyButtonProps {
  productId: string;
  label?: string;
  size?: 'default' | 'lg';
  className?: string;
}

/** A real link to checkout that fires buy_click on click. The click
 *  never prevents navigation; firing is fire-and-forget.
 *
 *  Gold is the store's single accent and is reserved for this, the
 *  primary buy action (design law, 2026-11-08 sprint); every other
 *  store action stays in the theme's neutral variants. */
export function BuyButton({
  productId,
  label = 'Buy now',
  size = 'lg',
  className,
}: BuyButtonProps) {
  const { fireBuyClick } = useStoreTracking();
  return (
    <Button
      asChild
      size={size}
      className={`bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300 ${className ?? ''}`}
    >
      <Link
        href={`/checkout?productId=${productId}&type=product`}
        onClick={() => fireBuyClick(productId)}
      >
        {label}
      </Link>
    </Button>
  );
}
