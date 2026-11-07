/**
 * role-definition-refresh — scheduling + change-detection primitives
 * for propagating role DEFINITION edits to live signed-in sessions.
 *
 * Problem (founder incident, 2026-11-07): UserProvider resolves a
 * holder's permissions from roleDefinitions/{slug} in a ONE-SHOT fetch
 * at login / roles-doc snapshot. Editing a definition therefore never
 * reached an already signed-in holder — a 17:49 grant was still
 * invisible at 18:54 because nothing re-fetched the definition.
 *
 * Fix shape: UserProvider re-runs that same one-shot fetch on bounded
 * triggers (window focus, visibility return, a 10-minute interval
 * while the tab is visible) driven by the shared usePollingRefresh
 * hook. This module carries the two pieces that make that safe:
 *
 *  - createRefreshGate: dedupes the triggers against each other and
 *    against the session's own login/snapshot fetches, so the cost is
 *    at most ONE single-document read per gate window per user. The
 *    gate window is the app's read-burn floor (MIN_POLL_INTERVAL_MS):
 *    the Firestore Spark budget is 50k reads/day shared with the live
 *    app, and a past outage came from exactly this kind of re-read.
 *
 *  - definitionFingerprint: a stable fingerprint of exactly the
 *    definition fields the provider consumes (name/label,
 *    allowedPaths, permissions, plus the legacy role_permissions
 *    fallback fields). A refresh whose fetched definition fingerprints
 *    identically to the last applied one performs NO state updates,
 *    so steady-state polling causes zero re-render churn.
 *
 * Deliberately NOT used here: the 'live-authority' surface. Flipping
 * it would also remove the roles/{uid} onSnapshot listener and
 * convert A22/B10 atomically (a gated cutover — see
 * src/lib/client-supa-flags.ts), and its poll re-runs the whole
 * snapshot handler (roles doc + definition + fallback + one read per
 * held custom role) — more reads per cycle than this fix's budget.
 */

/** Interval between definition refreshes while a tab stays visible. */
export const ROLE_DEFINITION_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export interface RefreshGate {
  /**
   * Attempt to start a gated fetch. Returns false when a fetch is
   * already in flight or the last fetch finished/started less than
   * the gate window ago; the caller must then skip its fetch.
   * A successful begin() stamps the window immediately, so a fetch
   * that hangs cannot be re-triggered inside the window either.
   */
  tryBegin: () => boolean;
  /** Mark the in-flight fetch finished (always call after begin). */
  end: () => void;
  /**
   * Record a fetch performed OUTSIDE the gate (the login-time and
   * roles-snapshot fetches in UserProvider) so triggers landing right
   * after them do not immediately re-read the same document.
   */
  stamp: () => void;
}

export function createRefreshGate(
  minIntervalMs: number,
  now: () => number = Date.now,
): RefreshGate {
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  return {
    tryBegin() {
      if (inFlight) return false;
      if (now() - lastFetchAt < minIntervalMs) return false;
      inFlight = true;
      lastFetchAt = now();
      return true;
    },
    end() {
      inFlight = false;
    },
    stamp() {
      lastFetchAt = now();
    },
  };
}

/** The definition fields UserProvider consumes from roleDefinitions. */
export interface DefinitionDocParts {
  name: unknown;
  label: unknown;
  allowedPaths: unknown;
  permissions: unknown;
}

/** The fields UserProvider consumes from the role_permissions fallback. */
export interface FallbackDocParts {
  label: unknown;
  allowedPaths: unknown;
  canAccessAdmin: boolean;
}

export interface DefinitionFingerprintInput {
  /** Normalized slug the documents were fetched under. */
  roleSlug: string;
  /** null when the roleDefinitions doc does not exist. */
  definition: DefinitionDocParts | null;
  /** null when the fallback doc was not fetched or does not exist. */
  fallback: FallbackDocParts | null;
}

/**
 * Stable fingerprint of one definition fetch. Two fetches fingerprint
 * equal iff every field the provider would apply is identical, so an
 * equal fingerprint guarantees re-applying would be a pure no-op.
 */
export function definitionFingerprint(input: DefinitionFingerprintInput): string {
  return JSON.stringify({
    slug: input.roleSlug,
    definition: input.definition
      ? {
          name: input.definition.name ?? null,
          label: input.definition.label ?? null,
          allowedPaths: Array.isArray(input.definition.allowedPaths)
            ? input.definition.allowedPaths
            : null,
          permissions: Array.isArray(input.definition.permissions)
            ? input.definition.permissions
            : null,
        }
      : null,
    fallback: input.fallback
      ? {
          label: input.fallback.label ?? null,
          allowedPaths: Array.isArray(input.fallback.allowedPaths)
            ? input.fallback.allowedPaths
            : null,
          canAccessAdmin: !!input.fallback.canAccessAdmin,
        }
      : null,
  });
}
