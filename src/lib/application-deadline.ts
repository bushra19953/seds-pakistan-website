'use client';

import { useEffect, useState } from 'react';

/**
 * Induction application window closes Friday Oct 16, 2026 at 11:59 PM PKT.
 * This is the single source of truth for the cutoff: the hero countdown,
 * the hero Apply Now CTA, and the /induction (also reached via /join and
 * /apply) portal all read it. Client-side gating only — the Firestore
 * rules path remains the server-side enforcement option for a later pass.
 */
export const APPLICATION_DEADLINE_ISO = '2026-10-16T23:59:59+05:00';
export const APPLICATION_DEADLINE_MS = new Date(APPLICATION_DEADLINE_ISO).getTime();

export function isApplicationWindowClosed(now: number = Date.now()): boolean {
  return now >= APPLICATION_DEADLINE_MS;
}

/**
 * SSR-safe hook: starts false on the server, re-checks on mount, ticks
 * every second so a page left open flips to closed exactly at the cutoff.
 */
export function useApplicationDeadline() {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const update = () => setExpired(isApplicationWindowClosed());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return { expired };
}
