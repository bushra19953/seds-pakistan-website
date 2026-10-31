'use client';

/**
 * Thin GD wrapper over GC's commerce analytics hook
 * (useCommerceAnalytics in src/lib/client/commerce-analytics.ts).
 * This is the only place GD code names the GC helper, so the contract
 * lives in one line per event. Firing is fire-and-forget: the GC
 * helper never throws, and neither function here may block or break
 * navigation.
 */
import { useCallback } from 'react';
import { useCommerceAnalytics } from '@/lib/client/commerce-analytics';

export function useStoreTracking() {
  const { trackCommerceEvent } = useCommerceAnalytics();
  const fireProductView = useCallback(
    (productId: string) => {
      void trackCommerceEvent('product_view', productId);
    },
    [trackCommerceEvent],
  );
  const fireBuyClick = useCallback(
    (productId: string) => {
      void trackCommerceEvent('buy_click', productId);
    },
    [trackCommerceEvent],
  );
  return { fireProductView, fireBuyClick };
}
