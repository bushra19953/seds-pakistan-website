'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { doc, increment, serverTimestamp } from 'firebase/firestore';
;
import { firestore, useUser } from '@/firebase';
import { setDoc, updateDoc } from '@/lib/client/firestore-wrapper';

export function PageVisitTracker() {
  const pathname = usePathname();
  const db = firestore; // Use the directly imported firestore instance
  const { user } = useUser(); // Get current user authentication state
  const enabled = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_ENABLE_VISIT_TRACKING ?? 'true') === 'true'
    : false;

  useEffect(() => {
    // 🔒 Only track when enabled, visible tab, authenticated user
    if (!enabled || !pathname || !user) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    const trackVisit = async () => {
      const pageId = pathname.replace(/\//g, '_') || 'home';
      const pageRef = doc(firestore, 'pageVisits', pageId);
      const totalVisitsRef = doc(firestore, 'pageVisits', 'site_total_visits');

      try {
        // Prefer update with atomic increment; fallback to create if not found
        await updateDoc(pageRef, {
          path: pathname,
          visits: increment(1),
          lastVisit: serverTimestamp(),
        } as any);
      } catch (err: any) {
        const code = err?.code;
        if (code === 'not-found') {
          try {
            await setDoc(pageRef, {
              path: pathname,
              visits: 1,
              lastVisit: serverTimestamp(),
            } as any, { merge: true });
          } catch (innerErr: any) {
            if (process.env.NODE_ENV === 'development') {
              console.debug('PageVisitTracker pageRef setDoc failed:', innerErr);
            }
          }
        } else if (process.env.NODE_ENV === 'development') {
          if (code === 'permission-denied') {
            console.log('Page visit tracking skipped - insufficient permissions');
          } else {
            console.debug('PageVisitTracker updateDoc failed:', err);
          }
        }
      }

      try {
        await updateDoc(totalVisitsRef, {
          visits: increment(1),
          lastVisit: serverTimestamp(),
        } as any);
      } catch (err: any) {
        const code = err?.code;
        if (code === 'not-found') {
          try {
            await setDoc(totalVisitsRef, {
              visits: 1,
              lastVisit: serverTimestamp(),
            } as any, { merge: true });
          } catch (innerErr: any) {
            if (process.env.NODE_ENV === 'development') {
              console.debug('PageVisitTracker totalVisitsRef setDoc failed:', innerErr);
            }
          }
        } else if (process.env.NODE_ENV === 'development') {
          if (code === 'permission-denied') {
            console.log('Page visit tracking skipped - insufficient permissions');
          } else {
            console.debug('PageVisitTracker updateDoc total failed:', err);
          }
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
