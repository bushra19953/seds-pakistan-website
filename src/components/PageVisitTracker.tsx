'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@/firebase';
import { serverWrite } from '@/lib/client/server-write';
import { collapseDynamicPath } from '@/components/page-visit-path';

export function PageVisitTracker() {
  const rawPathname = usePathname();
  // Report the collapsed route pattern, not the raw path: one
  // pageVisits doc per route (e.g. /blog/:slug) instead of one per
  // slug/id/code, so the collection stops growing unboundedly
  // (read-bleed census 21). Static paths are unchanged.
  const pathname = rawPathname ? collapseDynamicPath(rawPathname) : rawPathname;
  const { user } = useUser(); // Get current user authentication state
  const enabled = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING ?? 'true') === 'true'
    : false;

  useEffect(() => {
    // 🔒 Only track when enabled, visible tab, authenticated user
    if (!enabled || !pathname || !user) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    const trackVisit = async () => {
      // WS10: the increment / not-found-create logic for both
      // pageVisits docs runs server-side in POST /api/analytics/track
      // (kind 'pageVisit'); failures stay silent outside development,
      // as they were here.
      try {
        await serverWrite('/api/analytics/track', 'POST', { kind: 'pageVisit', path: pathname });
      } catch (err: any) {
        if (process.env.NODE_ENV === 'development') {
          console.debug('PageVisitTracker track failed:', err);
        }
      }
    };

    // ⏱️ Throttle per-path writes to reduce chatter (10 minutes window)
    try {
      const key = `pv_last_${pathname}`;
      const last = typeof sessionStorage !== 'undefined' ? Number(sessionStorage.getItem(key) || '0') : 0;
      const now = Date.now();
      const windowMs = 10 * 60 * 1000;
      if (!last || now - last > windowMs) {
        trackVisit();
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, String(now));
      }
    } catch {
      // If storage is unavailable, still attempt once
      trackVisit();
    }
  }, [enabled, pathname, user]);

  return null;
}
