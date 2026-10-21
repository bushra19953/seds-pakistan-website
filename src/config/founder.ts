/**
 * Founder identity - single source of truth (Phase 1, spec A.5 / P21).
 *
 * This module imports nothing from the role system, so client, server,
 * rules-stamping, and tests can all depend on it without import cycles.
 * The Founder's root power is an explicit UID check, never a role string:
 * a roles-doc edit can neither create a second root nor remove the real one.
 */

const FOUNDER_UID_FALLBACK = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

export const FOUNDER_UID: string =
  process.env.NEXT_PUBLIC_FIREBASE_FOUNDER_UID || FOUNDER_UID_FALLBACK;

/**
 * One element today. A future second founder-grade UID (Decision 6) is a
 * config change here only, not a grep-and-edit across the repo.
 */
export const FOUNDER_UIDS: readonly string[] = [FOUNDER_UID];

/** The catalog key the Founder displays as (spec A.1 row 1). */
export const FOUNDER_ROLE_KEY = 'founder_patron' as const;

export function isFounderUid(uid: string | null | undefined): boolean {
  if (!uid) return false;
  return FOUNDER_UIDS.includes(uid);
}
