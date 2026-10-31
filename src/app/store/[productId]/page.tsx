// Product page (Server Component). Reads go through the single
// projection in src/lib/server/store-catalogue.ts; raw product docs
// never render here. Read budget: the page costs 1 product get, 1
// vendor get, and 1 alternatives query (same vendor only);
// generateMetadata repeats the product and vendor gets, the same
// pattern the events detail page uses.

import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { getDb } from '@/lib/server/firebase-admin';
import {
  getCatalogueProduct,
  listAlternatives,
} from '@/lib/server/store-catalogue';
import type { CatalogueProduct } from '@/types/store-catalogue';
import { AlternativesRail } from '@/components/store/alternatives-rail';
import { BuyButton } from '@/components/store/buy-button';
import { GroupBuySlot } from '@/components/store/group-buy-slot';
import { ProductViewTracker } from '@/components/store/product-view-tracker';
import { WaitlistForm } from '@/components/store/waitlist-form';
import { deliveryPromiseLine, sellerLine } from '@/components/store/product-card';

function truncate(text: string, maxLen = 155): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 80 ? slice.slice(0, lastSpace) : slice) + '…';
}

async function loadProduct(productId: string): Promise<CatalogueProduct | null> {
  const db = getDb();
  if (!db) {
    console.error('[store product page] Firestore not initialized');
    return null;
  }
  return getCatalogueProduct(db, productId);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ productId: string }>;
}): Promise<Metadata> {
  const { productId } = await params;
  const product = await loadProduct(productId);
  if (!product) {
    return { title: 'Product not found | SEDS Pakistan Store' };
  }
  return {
    title: `${product.name} | SEDS Pakistan Store`,
    description: truncate(product.description),
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  const product = await loadProduct(productId);
  if (!product) notFound();

  const db = getDb();
  const alternatives = db ? await listAlternatives(db, product) : [];
  const railLabel = product.inStock ? 'Also available' : 'Available instead';

  return (
    <main className="container mx-auto px-4 py-10 md:px-6">
      <ProductViewTracker productId={product.id} />
      <Link href="/store" className="inline-flex min-h-[44px] items-center gap-2 underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to store
      </Link>

      <div className="mt-4 grid gap-8 md:grid-cols-2">
        <div className="relative aspect-[4/3] bg-muted">
          {product.imageUrl ? (
            <Image
              src={product.imageUrl}
              alt={product.name}
              fill
              sizes="(max-width: 768px) 100vw, 50vw"
              className="object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center" aria-hidden="true">
              <Package className="h-12 w-12 text-muted-foreground" />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h1 className="text-3xl font-bold">{product.name}</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
            <span>{sellerLine(product.businessName)}</span>
            <Link href="/store/returns" className="underline">
              Returns policy
            </Link>
          </p>
          <div>
            <Badge variant={product.inStock ? 'default' : 'secondary'}>
              {product.inStock ? 'In stock' : 'Out of stock'}
            </Badge>
          </div>
          {product.deliveryPromiseDays !== null && (
            <p className="text-muted-foreground">
              {deliveryPromiseLine(product.deliveryPromiseDays)}
            </p>
          )}
          {product.dispatchWindowWorkingDays !== null && (
            <p className="text-muted-foreground">
              {product.dispatchWindowWorkingDays === 1
                ? 'Ships within 1 working day'
                : `Ships within ${product.dispatchWindowWorkingDays} working days`}
            </p>
          )}
          <div className="space-y-1 text-lg">
            <p>Price: PKR {product.price.toLocaleString()}</p>
            <p>
              Delivery:{' '}
              {product.deliveryChargePkr > 0
                ? `PKR ${product.deliveryChargePkr.toLocaleString()}`
                : 'Free'}
            </p>
            <p className="font-bold">
              Total: PKR {(product.price + product.deliveryChargePkr).toLocaleString()}
            </p>
          </div>

          {product.inStock ? (
            <div className="space-y-3">
              <BuyButton productId={product.id} />
              <p className="text-sm text-muted-foreground">
                Pay by bank transfer or EasyPaisa. Upload your receipt at checkout.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <AlternativesRail products={alternatives} label={railLabel} />
              <h2 className="text-xl font-semibold">I want this</h2>
              <p className="text-muted-foreground">
                This item is out of stock. Leave your name and WhatsApp number and we
                will contact you if it becomes available.
              </p>
              <WaitlistForm
                source="product_page_oos"
                productId={product.id}
                initialRequestedText={product.name}
              />
            </div>
          )}

          <GroupBuySlot product={product} />
        </div>
      </div>

      <section className="mt-10">
        <h2 className="mb-2 text-xl font-semibold">About this product</h2>
        <p className="whitespace-pre-line text-muted-foreground">{product.description}</p>
      </section>

      {product.inStock && <AlternativesRail products={alternatives} label={railLabel} />}

      <p className="mt-12 text-sm">
        <Link href="/store/returns" className="underline">
          Returns policy
        </Link>
      </p>
    </main>
  );
}
