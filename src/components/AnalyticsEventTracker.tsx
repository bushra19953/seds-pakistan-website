'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { firestore, useUser } from '@/firebase';

/**
 * Lightweight, privacy-conscious analytics tracker.
 * - Tracks page views and click interactions for authenticated users only.
 * - Honors `NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS` feature flag.
 * - Writes to `analyticsEvents` collection for admin analysis.
 */
export default function AnalyticsEventTracker() {
  const pathname = usePathname();
  const { user } = useUser();
  const sessionStartMs = useRef<number>(Date.now());
  const maxScrollPct = useRef<number>(0);

  const enabled = typeof window !== 'undefined'
    && process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS === 'true';
  const globalTrackingEnabled = typeof window !== 'undefined'
    && ((process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING ?? 'true') === 'true');

  useEffect(() => {
    if (!enabled || !globalTrackingEnabled || !user || !pathname) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    const trackPageView = async () => {
      try {
        await addDoc(collection(firestore, 'analyticsEvents'), {
          type: 'page_view',
          path: pathname,
          userId: user.uid,
          referrer: typeof document !== 'undefined' ? document.referrer || null : null,
          ua: typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 128) : null,
          timestamp: serverTimestamp(),
        });
      } catch (err) {
        // Silent failure — analytics is non-critical
        // Optionally log in debug builds
      }
    };

    trackPageView();
  }, [enabled, globalTrackingEnabled, user, pathname]);

  useEffect(() => {
    if (!enabled || !user) return;

    const handleClick = async (evt: MouseEvent) => {
      const target = evt.target as HTMLElement | null;
      if (!target) return;

      // Resolve a meaningful clickable ancestor (button/anchor or data attributes)
      const clickable = target.closest('[data-analytics-id], a, button');
      if (!clickable) return;

      const el = clickable as HTMLElement;
      const targetId = el.getAttribute('data-analytics-id') || el.id || null;
      const labelAttr = el.getAttribute('data-analytics-label');
      const label = (labelAttr || el.textContent || '').trim().slice(0, 64) || null;
      const href = el instanceof HTMLAnchorElement ? el.href : null;

      try {
        await addDoc(collection(firestore, 'analyticsEvents'), {
          type: 'click',
          path: pathname || null,
          userId: user.uid,
          targetId,
          label,
          href,
          timestamp: serverTimestamp(),
        });
      } catch (err) {
        // Silent failure — analytics is non-critical
      }
    };

    document.addEventListener('click', handleClick, { capture: true });
    return () => {
      document.removeEventListener('click', handleClick, { capture: true } as any);
    };
  }, [enabled, user, pathname]);

  // Track scroll depth in-memory only; do not flush on unload/hidden
  useEffect(() => {
    if (!enabled || !globalTrackingEnabled || !user || !pathname) return;

    // Reset session markers per page
    sessionStartMs.current = Date.now();
    maxScrollPct.current = 0;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const doc = document.documentElement;
        const maxScrollable = (doc.scrollHeight || 0) - window.innerHeight;
        if (maxScrollable > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((window.scrollY / maxScrollable) * 100)));
          if (pct > maxScrollPct.current) maxScrollPct.current = pct;
        }
        ticking = false;
      });
    };

    // Disabled: flushing session metrics on unload/hidden can cause teardown noise

    window.addEventListener('scroll', onScroll, { passive: true });
    // No visibilitychange/beforeunload listeners — avoids Firestore write channel closing errors

    return () => {
      window.removeEventListener('scroll', onScroll as any);
    };
  }, [enabled, globalTrackingEnabled, user, pathname]);

  return null;
}
