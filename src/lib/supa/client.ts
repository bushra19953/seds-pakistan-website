/**
 * Supabase server client factory (server-only).
 *
 * Part of the Firestore -> Supabase migration (DB only; Firebase Auth is
 * untouched). API routes verify the Firebase ID token as they do today and
 * then read/write Postgres through the adapter in `adapter.ts`, using this
 * client, which authenticates with the project's service_role key. The
 * service key bypasses Row Level Security, so this module must NEVER be
 * imported from client components or any bundle that ships to the browser.
 *
 * Configuration is read from the environment at call time:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * When either variable is missing the factory returns null (it never
 * throws), so callers can fall back to Firestore:
 *
 *   const client = getSupaClient();
 *   if (useSupa('announcements') && client) { ...supa path... }
 *   else { ...firestore path... }
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Returns a memoized service-role Supabase client, or null when Supabase is
 * not configured in this process's environment.
 */
export function getSupaClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cached = createClient(url, key, {
    auth: {
      // Server-side service client: no session to persist or refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cached;
}

/** Drops the memoized client. Exists for tests; production code never calls it. */
export function resetSupaClientForTests(): void {
  cached = null;
}
