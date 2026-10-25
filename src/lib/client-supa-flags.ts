'use client';

/**
 * client-supa-flags — the canonical client-side Supabase surface flag.
 *
 * Semantics identical to the precedent set by the notifications seam
 * (src/lib/notifications-supa-client.ts): NEXT_PUBLIC_SUPA_SURFACES is
 * a comma-separated list of surface names, case-insensitive, whitespace
 * tolerated. A surface is ON only when the list contains its name.
 * Unset/empty = every surface OFF, so a gated conversion with the flag
 * off is byte-identical to the pre-migration behavior.
 *
 * Client components cannot read server-only env, which is why this
 * flag is NEXT_PUBLIC_*. Server surfaces use the adapter's useSupa()
 * with server env instead; do not mix the two.
 */

/** Surface gating the bounded-polling conversions of live admin listeners. */
export const LIVE_ADMIN_SURFACE = 'live-admin';

/**
 * Parse a NEXT_PUBLIC_SUPA_SURFACES value and report whether `surface`
 * is enabled. Unset/empty = OFF for every surface.
 */
export function isClientSupaSurfaceOn(
  surface: string,
  raw: string | undefined = process.env.NEXT_PUBLIC_SUPA_SURFACES,
): boolean {
  if (!raw) return false;
  const wanted = surface.trim().toLowerCase();
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}
