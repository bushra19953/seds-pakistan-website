/**
 * Cadetship permission gates (phase2_spec.md Section F.8).
 *
 * The matrix, over CATALOG role keys (the roles/{uid} store vocabulary):
 *   manage: national_membership_director (all chapters),
 *           chapter_president (own chapter only), founder (isFounderUid
 *           is checked by callers - the Founder holds no catalog role).
 *   read:   the managers, plus national_general_secretary and
 *           national_audit_compliance_chair (read-only oversight).
 *
 * These helpers are the client/display-side gate. The authoritative
 * enforcement lives in the cadetship API routes, which re-resolve the
 * caller's role server-side on every request; a UI that disagrees with
 * the API loses.
 */

export const CADETSHIP_MANAGE_ROLES = [
  'national_membership_director',
  'chapter_president',
] as const;

export const CADETSHIP_READ_ROLES = [
  'national_membership_director',
  'chapter_president',
  'national_general_secretary',
  'national_audit_compliance_chair',
] as const;

export function canManageCadetships(
  roleKey: string | null | undefined,
  options?: { callerChapterId?: string | null; cadetshipChapterId?: string | null; isFounder?: boolean },
): boolean {
  if (options?.isFounder) return true;
  if (roleKey === 'national_membership_director') return true;
  if (roleKey === 'chapter_president') {
    // Chapter presidents manage only their own chapter's cadetships.
    if (options?.cadetshipChapterId == null) return true; // list-level gate
    return options?.callerChapterId != null && options.callerChapterId === options.cadetshipChapterId;
  }
  return false;
}

export function canViewCadetships(
  roleKey: string | null | undefined,
  options?: { callerChapterId?: string | null; cadetshipChapterId?: string | null; isFounder?: boolean },
): boolean {
  if (canManageCadetships(roleKey, options)) return true;
  if (roleKey === 'national_general_secretary' || roleKey === 'national_audit_compliance_chair') {
    return true;
  }
  if (roleKey != null && roleKey.startsWith('chapter_')) {
    if (options?.cadetshipChapterId == null) return true;
    return options?.callerChapterId != null && options.callerChapterId === options.cadetshipChapterId;
  }
  return false;
}
