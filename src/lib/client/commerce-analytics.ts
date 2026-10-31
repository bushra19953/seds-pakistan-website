'use client';

import { useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@/firebase';
import { serverWrite } from '@/lib/client/server-write';

export type CommerceEventType =
  | 'product_view'
  | 'buy_click'
  | 'checkout_start'
  | 'order_created';

export const COMMERCE_EVENT_TYPES: readonly CommerceEventType[] = [
  'product_view',
  'buy_click',
  'checkout_start',
  'order_created',
];

export type TrackCommerceEvent = (
  type: CommerceEventType,
  productId: string,
  path?: string,
) => Promise<void>;

// Coordinator ruling R-13: this helper does not gate on
// NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS. That flag governs the
// legacy AnalyticsEventTracker only. The gates here are a
// signed-in user and the global visit-tracking flag.
export function commerceAnalyticsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return (process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING ?? 'true') === 'true';
}

export function useCommerceAnalytics(): {
  trackCommerceEvent: TrackCommerceEvent;
} {
  const { user } = useUser();
  const pathname = usePathname();

  const trackCommerceEvent = useCallback<TrackCommerceEvent>(
    async (type, productId, path) => {
      if (!user) return;
      if (!commerceAnalyticsEnabled()) return;
      if (typeof productId !== 'string' || productId.trim().length === 0) {
        return;
      }
      try {
        await serverWrite('/api/analytics/track', 'POST', {
          kind: 'analyticsEvent',
          event: {
            type,
            path: path ?? pathname ?? null,
            productId: productId.trim(),
          },
        });
      } catch {
        // Analytics is non-critical; failures stay silent.
      }
    },
    [user, pathname],
  );

  return { trackCommerceEvent };
}
