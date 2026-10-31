'use client';

import { useEffect, useRef } from 'react';
import { useStoreTracking } from '@/lib/store/track';

/** Fires product_view once per productId mount. Rendered by the
 *  product page, so arrivals from the alternatives rail fire the
 *  clicked product's view exactly like a direct visit. */
export function ProductViewTracker({ productId }: { productId: string }) {
  const { fireProductView } = useStoreTracking();
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (firedFor.current === productId) return;
    firedFor.current = productId;
    fireProductView(productId);
  }, [productId, fireProductView]);

  return null;
}
