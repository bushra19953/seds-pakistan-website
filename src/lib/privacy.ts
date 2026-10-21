/**
 * Privacy helpers (spec section 5: Privacy Shielding).
 *
 * Contact details (phone / WhatsApp / email) are masked at render time in
 * directory-style listings and public views, never at rest. Assignees viewing
 * their own task PDFs keep full contacts (they need them); these helpers are
 * not applied there.
 *
 * Unmasking is restricted to chairs and presidents (see canUnmaskContacts)
 * and every unmask must be written to the `audit_logs` collection
 * (surfaced at /admin/audit-logs) via logContactUnmask.
 */

import { isNationalExecutive, isChapterExecutive } from './roles';
import { normalizeToCanonical } from './role-catalog';

/** Name of the Firestore field on user docs controlling public directory
 *  visibility. The public profile hub (/u/:username) reads exactly this
 *  field name. */
export const PUBLIC_DIRECTORY_OPT_IN_FIELD = 'publicDirectoryOptIn';

/** Bullet used when masking contact values. */
const MASK_CHAR = '•';

/**
 * Mask a phone / WhatsApp number, keeping the country prefix and the last
 * three digits so an admin can still tell numbers apart:
 *   '+92 331 0451655' -> '+92 331 ••••655'
 * Short or empty values are fully masked (or shown as a dash when empty).
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone || !phone.trim()) return '—';
  const trimmed = phone.trim();
  const prefix = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length <= 5) return prefix + MASK_CHAR.repeat(Math.max(digits.length, 4));
  const head = digits.slice(0, 5);
  const last3 = digits.slice(-3);
  const middleCount = Math.max(digits.length - head.length - 3, 1);
  const grouped = head.length === 5 ? `${head.slice(0, 2)} ${head.slice(2)}` : head;
  return `${prefix}${grouped} ${MASK_CHAR.repeat(middleCount)}${last3}`;
}

/**
 * Mask an email address, keeping a short local-part prefix and the domain:
 *   'ahmedalikamran44@gmail.com' -> 'ahmed***@gmail.com'
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.trim()) return '—';
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return MASK_CHAR.repeat(5);
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const keep = local.length >= 6 ? 5 : local.length >= 3 ? 3 : 1;
  return `${local.slice(0, keep)}***@${domain}`;
}

/**
 * Who may unmask contact details in directory views: chairs and presidents
 * (plus superadmin / developer). Chairs normalize to national VP roles or
 * *_chair canonical roles via the legacy role map in roles.ts.
 */
export function canUnmaskContacts(rawRole: string | null | undefined): boolean {
  if (!rawRole) return false;
  // Phase 1 (spec A.5): resolve through the catalog; the retired string
  // checks ('superadmin' / 'developer' as stored values) are replaced by
  // their catalog successors. Unresolvable tokens unmask nothing.
  const role = normalizeToCanonical(rawRole);
  if (!role) return false;
  if (role === 'chief_technology_officer' || role === 'platform_developer') return true;
  if (isNationalExecutive(role) || isChapterExecutive(role)) return true;
  // Chapter-level chairs, e.g. chapter_design_chair.
  if (/_chair$/.test(role)) return true;
  return false;
}

/**
 * Default for the publicDirectoryOptIn flag when a member has not set it:
 * executives are listed by default, everyone else is not.
 */
export function defaultPublicDirectoryOptIn(rawRole: string | null | undefined): boolean {
  if (!rawRole) return false;
  // Phase 1 (spec A.5): catalog resolution only; invented tokens such as
  // national_vp_operations no longer default anyone into the directory.
  const role = normalizeToCanonical(rawRole);
  if (!role) return false;
  if (role === 'chief_technology_officer' || role === 'platform_developer') return true;
  if (isNationalExecutive(role) || isChapterExecutive(role)) return true;
  if (/_chair$/.test(role)) return true;
  return false;
}

/**
 * Effective public-directory visibility for a profile doc: an explicit
 * stored boolean always wins; otherwise the role-based default applies.
 */
export function resolvePublicDirectoryOptIn(
  profile: { publicDirectoryOptIn?: unknown; role?: string | null; displayRole?: string | null } | null | undefined,
): boolean {
  if (!profile) return false;
  if (typeof profile.publicDirectoryOptIn === 'boolean') return profile.publicDirectoryOptIn;
  return defaultPublicDirectoryOptIn(profile.role || profile.displayRole);
}
