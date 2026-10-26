/**
 * Feature flags for the Firestore -> Supabase migration.
 *
 * Despite the React-hook-style name (kept to match the migration plan's
 * vocabulary), `useSupa` is a plain server-side environment check, not a
 * hook: it reads `SUPA_SURFACES` at call time and answers whether one named
 * surface (e.g. 'announcements', 'directory') is switched to Supabase.
 *
 *   SUPA_SURFACES=announcements,directory
 *
 * Rules:
 * - Unset or empty: every surface is OFF (the default; Firestore serves).
 * - '*' anywhere in the list: every surface is ON.
 * - Matching is case-insensitive and ignores surrounding whitespace.
 *
 * The flag is only half of the gate. Callers must also confirm a client
 * exists, because an ON flag with no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * configured must still fall back to Firestore:
 *
 *   if (useSupa('announcements') && getSupaClient()) { ... }
 *
 * SUPA_PRIMARY (cutover program, Option A — foundation wave):
 *
 *   SUPA_PRIMARY=events,elections
 *
 * `SUPA_PRIMARY` names the surfaces for which Supabase is the WRITE-PRIMARY
 * store (single writer; Firestore is no longer written for that surface).
 * It uses the exact same comma-only parser as `SUPA_SURFACES` — same
 * splitting, trimming, lower-casing, empty-token dropping, and '*'
 * handling — so the two env vars can never drift in parsing behaviour.
 *
 * FLAG LAW: a surface is write-primary iff its token is in BOTH
 * `SUPA_SURFACES` and `SUPA_PRIMARY`:
 *
 *   isSupaPrimary(s)  ===  useSupa(s) && token(s) in SUPA_PRIMARY
 *
 * `SUPA_PRIMARY` default OFF (unset / empty / no matching token) is
 * byte-identical to the pre-cutover behaviour: flipped surfaces dual-write
 * with Firestore as primary. Rollback per surface = remove its
 * `SUPA_PRIMARY` token (returns to dual-write); remove its `SUPA_SURFACES`
 * token = full Firestore fallback. Server-side only in this step — no
 * client twin (`NEXT_PUBLIC_SUPA_PRIMARY`) is defined or needed yet.
 */

function parseCommaTokens(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function parseSupaSurfaces(raw: string | undefined): Set<string> {
  return parseCommaTokens(raw);
}

/** Parses `SUPA_PRIMARY` with the identical comma-only rules as `SUPA_SURFACES`. */
export function parseSupaPrimary(raw: string | undefined): Set<string> {
  return parseCommaTokens(raw);
}

function tokenIn(raw: string | undefined, surface: string): boolean {
  const tokens = parseCommaTokens(raw);
  if (tokens.size === 0) return false;
  if (tokens.has('*')) return true;
  return tokens.has(surface.trim().toLowerCase());
}

export function useSupa(surface: string): boolean {
  return tokenIn(process.env.SUPA_SURFACES, surface);
}

/**
 * Write-primary gate for the cutover: true iff the surface's token is in
 * BOTH `SUPA_SURFACES` and `SUPA_PRIMARY`. A token in `SUPA_PRIMARY` alone
 * changes nothing (the surface is not even read-flipped), and a token in
 * `SUPA_SURFACES` alone keeps today's dual-write behaviour.
 */
export function isSupaPrimary(surface: string): boolean {
  if (!useSupa(surface)) return false;
  return tokenIn(process.env.SUPA_PRIMARY, surface);
}
