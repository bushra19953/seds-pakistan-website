'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useVendorApi, VENDOR_GATE_MESSAGE, type VendorApiError } from '../components/use-vendor-api';
import { EmptyState } from '../components/empty-state';

interface VendorProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  isActive: boolean;
  deliveryPromiseDays: number | null;
}

export default function VendorProductsPage() {
  const { get, user } = useVendorApi();
  const [products, setProducts] = useState<VendorProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    get('/api/vendor/products')
      .then((d: { products: VendorProduct[] }) => setProducts(d.products))
      .catch((e: VendorApiError) => setError(e.status === 403 ? VENDOR_GATE_MESSAGE : e.error));
  }, [get, user]);

  if (error) return <EmptyState title="Products" body={error} />;
  if (!products) return <p className="text-sm text-muted-foreground">Loading</p>;
  if (products.length === 0) {
    return <EmptyState title="No products yet" body="Your products will appear here once the SEDS Pakistan team lists them." />;
  }

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Products</h1>
      {products.map((p) => (
        <Card key={p.id}>
          <CardContent className="py-4 flex items-center gap-4">
            {p.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.imageUrl} alt={p.name} className="h-14 w-14 rounded object-cover" />
            ) : (
              <div className="h-14 w-14 rounded bg-muted flex items-center justify-center font-bold">
                {(p.name ?? '?').slice(0, 1)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate">{p.name}</p>
              <p className="text-sm text-muted-foreground">
                {p.stock > 0 ? `In stock: ${p.stock}` : 'Out of stock'}
                {p.deliveryPromiseDays != null ? ` · Delivery in ${p.deliveryPromiseDays} days` : ''}
              </p>
            </div>
            <p className="font-bold tabular-nums">PKR {(p.price ?? 0).toLocaleString('en-PK')}</p>
            <Badge variant={p.isActive ? 'default' : 'secondary'}>{p.isActive ? 'Listed' : 'Not listed'}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
