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
 * Surface gating the Class E authority conversions (listeners-ce):
 * A21 (UserProvider roles listener), A22 (useRole), B10 (role-registry
 * roleDefinitions) and A23 (authority_refresh signal) move TOGETHER
 * behind this one token, per the F5 parity pack's atomicity item —
 * never independently. Default OFF = every authority listener runs
 * on Firestore exactly as before.
 */
export const LIVE_AUTHORITY_SURFACE = 'live-authority';

/**
 * Surface gating the Class C chat conversions (listeners-ce):
 * B17 (workflow chat messages), A19 (typing) and A20 (presence) in
 * enhanced-workflow-chat, plus A18 (dormant visualizer presence),
 * move behind this one token. Default OFF = Firestore listeners
 * exactly as before. X4 (the presence heartbeat WRITE) is not a
 * listener and does not move under this flag.
 */
export const LIVE_CHAT_SURFACE = 'live-chat';

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

/**
 * Hook-shaped accessor used by the Class D one-shot conversions
 * (carried over from the D branch at the M1 union merge; delegates to
 * the parser so both call forms always agree).
 */
export function useClientSupaSurface(surface: string): boolean {
  return isClientSupaSurfaceOn(surface);
}
