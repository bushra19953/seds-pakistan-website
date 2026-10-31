/**
 * Client-safe half of the public-timeline seam (Firestore -> Supabase
 * migration, timeline surface, built 2026-11-01 on the E4 events
 * pattern: src/lib/supa-events/public-events-client.ts).
 *
 * Browser code may import ONLY this module: it contains no adapter
 * import. The server seam (public-timeline.ts) statically binds
 * `@/lib/supa`, which holds the service_role key and must never ship
 * in a browser bundle.
 *
 * The hint below only tells a component to ATTEMPT the server route
 * (/api/timeline/public). The route re-checks the server flag
 * SUPA_SURFACES (via the adapter's useSupa) and answers 503 when the
 * 'timeline' surface is off, so a stale or forged hint can never widen
 * access — the component falls back to Firestore on any failure.
 */

export const PUBLIC_TIMELINE_SURFACE = 'timeline';

export function surfaceListHas(raw: string | undefined, surface: string): boolean {
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes(surface);
}

/**
 * Client-side hint: the NEXT_PUBLIC_ twin of SUPA_SURFACES lists the
 * 'timeline' surface. Read at call time so tests and runtime config
 * changes are honored.
 */
export function publicTimelineSupaClientEnabled(): boolean {
  return surfaceListHas(process.env.NEXT_PUBLIC_SUPA_SURFACES, PUBLIC_TIMELINE_SURFACE);
}
