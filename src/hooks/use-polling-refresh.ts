'use client';

import { useEffect, useRef } from 'react';

/**
 * Minimum interval any client polling surface may use, in milliseconds.
 *
 * Read-burn rule (2026-10-24 audit): polling re-reads the full returned
 * set on every cycle, and the Firestore Spark budget is 50k reads/day
 * shared with the live app. A forgotten always-open tab polling every
 * 30-60 seconds can consume the entire daily quota by itself. No surface
 * in this app is genuinely real-time enough to justify polling faster
 * than every 5 minutes, so the floor is enforced here, in the one hook
 * every polling surface shares: callers may ask for a shorter interval,
 * they will not get one.
 */
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically refresh client data, read-burn safe:
 *
 * - The effective interval is clamped to at least MIN_POLL_INTERVAL_MS.
 * - Polling pauses while the browser tab is hidden
 *   (document.visibilitychange) and, on becoming visible again, fires
 *   exactly one immediate refresh before resuming the interval, so a
 *   returning user never waits a full cycle for fresh data.
 * - The initial load is the caller's job; this hook only drives the
 *   repeat refreshes.
 *
 * @param onRefresh  Called on each poll tick and once on tab re-show.
 * @param intervalMs Requested interval; clamped up to the floor.
 * @param enabled    When false, no timer runs and no refresh fires.
 */
export function usePollingRefresh(
  onRefresh: () => void,
  intervalMs: number,
  enabled: boolean = true,
): void {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const effectiveMs = Math.max(intervalMs, MIN_POLL_INTERVAL_MS);

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => refreshRef.current(), effectiveMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        // One immediate refresh so returning to the tab shows fresh
        // data, then resume the normal cadence.
        refreshRef.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [effectiveMs, enabled]);
}
