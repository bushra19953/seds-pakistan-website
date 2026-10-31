import Image from 'next/image';
import Link from 'next/link';
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
 *  the card itself is not clickable. */
export function ProductCard({ product }: { product: CatalogueProduct }) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="relative aspect-[4/3] bg-muted">
        {product.imageUrl ? (
          <Image
            src={product.imageUrl}
            alt={product.name}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center" aria-hidden="true">
            <Package className="h-10 w-10 text-muted-foreground" />
          </div>
        )}
      </div>
      <CardContent className="flex flex-1 flex-col gap-2 pt-4">
        <h3 className="font-semibold leading-snug">
          <Link href={`/store/${product.id}`} className="hover:underline">
            {product.name}
          </Link>
        </h3>
        <p className="text-sm text-muted-foreground">{sellerLine(product.businessName)}</p>
        <p className="text-lg font-bold">PKR {product.price.toLocaleString()}</p>
        <div>
          <Badge variant={product.inStock ? 'default' : 'secondary'}>
            {product.inStock ? 'In stock' : 'Out of stock'}
          </Badge>
        </div>
        {product.deliveryPromiseDays !== null && (
          <p className="text-sm text-muted-foreground">
            {deliveryPromiseLine(product.deliveryPromiseDays)}
          </p>
        )}
        <div className="mt-auto pt-2">
          {product.inStock ? (
            <BuyButton productId={product.id} label="Buy" size="default" />
          ) : (
            <Button asChild variant="outline">
              <Link href={`/store/${product.id}`}>I want this</Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
