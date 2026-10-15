'use client';

import { useEffect, useState } from 'react';

/**
 * Induction application window closes Saturday Oct 17, 2026 at 11:59 PM PKT.
 * This is the single source of truth for the cutoff: the hero countdown,
 * the hero Apply Now CTA, and the /induction (also reached via /join and
 * /apply) portal all read it. Client-side gating only — the Firestore
 * rules path remains the server-side enforcement option for a later pass.
 */
export const APPLICATION_DEADLINE_ISO = '2026-10-17T23:59:59+05:00';
export const APPLICATION_DEADLINE_MS = new Date(APPLICATION_DEADLINE_ISO).getTime();

// Fail fast at module load: an invalid ISO string parses to NaN, and
// `now >= NaN` is always false, which would silently keep the window open
// forever. A loud error beats a silently open gate.
if (!Number.isFinite(APPLICATION_DEADLINE_MS)) {
  throw new Error(`Invalid APPLICATION_DEADLINE_ISO: ${APPLICATION_DEADLINE_ISO}`);
}

/**
 * The single predicate every consumer uses to decide the window is closed.
 * Uses >= so the exact cutoff instant counts as closed.
 */
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
