/**
 * Feature flag for the Firestore -> Supabase migration.
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
 */

export function parseSupaSurfaces(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function useSupa(surface: string): boolean {
  const surfaces = parseSupaSurfaces(process.env.SUPA_SURFACES);
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(surface.trim().toLowerCase());
}
