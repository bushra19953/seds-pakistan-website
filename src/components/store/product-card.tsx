'use client';

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { CatalogueProduct } from '@/types/store-catalogue';
import { BuyButton } from './buy-button';

export function sellerLine(businessName: string): string {
  return businessName ? `Sold by ${businessName}` : 'Sold by the pilot seller';
}

export function deliveryPromiseLine(days: number): string {
  return days === 1 ? 'Delivery in 1 day' : `Delivery in ${days} days`;
}

/** One catalogue product. The name and the action are real links;
 *  the card itself is not clickable.
 *
 *  Presentation adapted from the 21st.dev klyv-ui Product Card pattern:
 *  the stock badge floats on the photo's corner instead of sitting in
 *  the text stack, the photo carries the hover treatment (a restrained
 *  scale, standing in for the pattern's hover-shot swap — the catalogue
 *  has one image per product), and the buy action is pinned full-width
 *  to the card's foot so every card ends in one clear action. The card
 *  lift and the image scale share one framer-motion hover variant and
 *  are both switched off for reduced-motion users. */
export function ProductCard({ product }: { product: CatalogueProduct }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="h-full"
      initial="rest"
      animate="rest"
      whileHover={reduceMotion ? undefined : 'hover'}
      variants={{
        rest: { y: 0 },
        hover: { y: -4 },
      }}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
    >
      <Card className="flex h-full flex-col overflow-hidden transition-shadow duration-300 hover:shadow-xl hover:shadow-black/30">
        <div className="relative aspect-[4/3] overflow-hidden bg-muted">
          <motion.div
            className="absolute inset-0"
            variants={{
              rest: { scale: 1 },
              hover: { scale: 1.05 },
            }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            {product.imageUrl ? (
              <Image
                src={product.imageUrl}
                alt={product.name}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                className={
                  product.inStock ? 'object-cover' : 'object-cover opacity-80 grayscale-[0.35]'
                }
              />
            ) : (
              <div className="flex h-full items-center justify-center" aria-hidden="true">
                <Package className="h-10 w-10 text-muted-foreground" />
              </div>
            )}
          </motion.div>
          <Badge
            variant={product.inStock ? 'default' : 'secondary'}
            className="absolute left-3 top-3 shadow-md"
          >
            {product.inStock ? 'In stock' : 'Out of stock'}
          </Badge>
        </div>
        <CardContent className="flex flex-1 flex-col gap-2 pt-4">
          <h3 className="font-semibold leading-snug">
            <Link href={`/store/${product.id}`} className="hover:underline">
              {product.name}
            </Link>
          </h3>
          <p className="text-sm text-muted-foreground">{sellerLine(product.businessName)}</p>
          <p className="text-lg font-bold">PKR {product.price.toLocaleString()}</p>
          {product.deliveryPromiseDays !== null && (
            <p className="text-sm text-muted-foreground">
              {deliveryPromiseLine(product.deliveryPromiseDays)}
            </p>
          )}
          <div className="mt-auto pt-2">
            {product.inStock ? (
              <BuyButton productId={product.id} label="Buy" size="default" className="w-full" />
            ) : (
              <Button asChild variant="outline" className="w-full">
                <Link href={`/store/${product.id}`}>I want this</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
