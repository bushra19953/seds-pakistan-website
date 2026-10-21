/**
 * DEPRECATED - server-side fallback shim (Workstream E transition).
 *
 * This file is kept ONLY as a server-side fallback for
 * GET /api/public/intake-window, used when the intake_windows
 * collection is empty. All client consumers have migrated to
 * useIntakeWindow (src/hooks/use-intake-window.ts) and the
 * data-driven intake window; do not import this file from client
 * code.
 */
export const APPLICATION_DEADLINE_ISO = '2026-10-22T23:59:59+05:00';
export const APPLICATION_DEADLINE_MS = new Date(APPLICATION_DEADLINE_ISO).getTime();

// Fail fast at module load: an invalid ISO string parses to NaN, and
// `now >= NaN` is always false, which would silently keep the window open
// forever. A loud error beats a silently open gate.
if (!Number.isFinite(APPLICATION_DEADLINE_MS)) {
  throw new Error(`Invalid APPLICATION_DEADLINE_ISO: ${APPLICATION_DEADLINE_ISO}`);
}
