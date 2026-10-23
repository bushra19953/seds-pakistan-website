/**
 * Role utilities (Phase 1 rewrite, spec A.2/A.5/A.6).
 *
 * Everything in this module derives from the single catalog table in
 * src/lib/role-catalog.ts. There is no second role list here. Resolution
 * distinguishes catalog / legacy / abolished / unknown; unmapped tokens are
 * never silently promoted to a fallback role. Display has exactly one
 * function (getRoleDisplayName). Founder handling is the explicit UID
 * check in src/config/founder.ts, never a role string.
 */

import {
  ROLE_CATALOG,
  type CatalogRoleKey,
  resolveRole,
  resolveRoleForUid,
  normalizeToCanonical,
  normalizeRoleSlug,
  catalogTitle,
  rankOf,
  rankValue,
  scopeOf,
  FOUNDER_DISPLAY_TITLE,
} from './role-catalog';
import {
  toCustomRoleDefinition,
  customRoleTitle,
  isCustomRoleSlug,
} from './custom-roles';
import { FOUNDER_UID, FOUNDER_UIDS, isFounderUid } from '@/config/founder';
import type { CanonicalRole, RoleScope } from '@/types/roles';

export { FOUNDER_UID, FOUNDER_UIDS, isFounderUid };
export { FOUNDER_DISPLAY_TITLE };
export type { CanonicalRole, RoleScope };

export type UserRole = string;

export interface RoleAssignment {
  uid: string;
  role: UserRole;
  assignedAt: Date;
  assignedBy?: string;
}

/**
 * Derived display map (catalog key -> title). Kept for the existing
 * importers of USER_ROLES; it is built from ROLE_CATALOG, never edited by
 * hand. Legacy keys (superadmin, president_national as a display string,
 * etc.) are intentionally absent: use catalogTitle / getRoleDisplayName.
 */
export const USER_ROLES: Record<string, string> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, r.title]),
);

export const ROLES = {
  FOUNDER: 'founder_patron',
  PRESIDENT_NATIONAL: 'president_national',
  CTO: 'chief_technology_officer',
} as const;

/** Derived numeric hierarchy: catalog rank value (R5=5 ... R0=0). */
export const ROLE_HIERARCHY: Record<string, number> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, rankValue(r.rank)]),
);

/** Resolve a raw token to its catalog key in the founder's context. */
function resolveFor(rawRole: string | null | undefined, uid?: string | null): CatalogRoleKey | null {
  const result = resolveRoleForUid(rawRole ?? null, uid ?? null, isFounderUid);
  if (result.kind === 'catalog' || result.kind === 'legacy') return result.key;
  return null;
}

/**
 * Rank comparison on resolved catalog keys. Unresolvable roles never pass.
 * The Founder passes by UID, not by any stored string.
 */
export function hasSufficientRole(
  userRole: UserRole,
  requiredRole: UserRole,
  userUid?: string,
): boolean {
  if (userUid && isFounderUid(userUid)) return true;
  const userKey = resolveFor(userRole, userUid ?? null);
  const requiredKey = resolveFor(requiredRole);
  if (!userKey || !requiredKey) return false;
  return rankValue(rankOf(userKey)) >= rankValue(rankOf(requiredKey));
}

/** Founder check (explicit UID, src/config/founder.ts). */
export function isFounder(uid: string): boolean {
  return isFounderUid(uid);
}

/**
 * Raw roleDefinitions docs a caller already holds, keyed by normalised
 * slug (Custom Roles Fix Program, contracts s.4.5). Callers that have
 * definitions (hierarchy, picker, PDF - consumers item) pass them so a
 * custom role renders its definition title; callers that do not get
 * the s.4.5 step 5 humanised floor for custom slugs (and byte-identical
 * output for every non-custom token). Values are RAW docs: the shared
 * core's four-part test runs here, so a junk definition supplies no
 * title.
 */
export type CustomRoleDefinitionsMap = ReadonlyMap<string, Record<string, unknown>>;

/**
 * The definition title for a custom slug, or null when the map holds
 * no valid definition for it. Title resolution is the contracts K3 /
 * s.4.5 read tolerance, in order: the definition's `name` (the field
 * of record; toCustomRoleDefinition already folds the legacy `label`
 * mirror into it), then the humanised slug via customRoleTitle. There
 * is NO `title` field on a definition - it is never read. A custom
 * slug with a valid definition at hand therefore never renders as its
 * raw slug or as 'Guest'.
 */
function customDefinitionTitle(
  role: string,
  definitions?: CustomRoleDefinitionsMap,
): string | null {
  if (!definitions) return null;
  const slug = normalizeRoleSlug(role);
  const data = definitions.get(slug);
  if (!data) return null;
  const def = toCustomRoleDefinition(slug, data);
  if (!def) return null;
  return customRoleTitle(def, slug);
}

/**
 * The display title for a custom slug in a sync helper (contracts
 * s.4.5, ruling R10): the definition title when a valid definition is
 * at hand (step 3), otherwise the HUMANISED SLUG floor (step 5) via
 * customRoleTitle(null, slug). A custom slug NEVER renders as its raw
 * slug, never as 'Guest', and never as 'Basic Member' - including
 * when no definitions map is supplied and when the map's entry fails
 * the four-part test. Non-custom tokens return null and keep today's
 * behaviour exactly.
 */
function customDisplayTitle(
  role: string,
  definitions?: CustomRoleDefinitionsMap,
): string | null {
  const slug = normalizeRoleSlug(role);
  if (!isCustomRoleSlug(slug)) return null;
  return customDefinitionTitle(role, definitions) ?? customRoleTitle(null, slug);
}

/**
 * The single display function (spec A.6). Order: founder UID -> catalog
 * title -> legacy target title -> custom title (definition title, or
 * the s.4.5 step 5 humanised floor when no valid definition is at
 * hand) -> 'Guest'. Non-string junk renders 'Guest' and never reaches
 * string methods (the Oct 2026 crash guard).
 */
export function getRoleDisplayName(
  role: UserRole,
  userUid?: string,
  definitions?: CustomRoleDefinitionsMap,
): string {
  if (userUid && isFounderUid(userUid)) return FOUNDER_DISPLAY_TITLE;
  if (!role) return 'Guest';
  if (typeof role !== 'string') return 'Guest';
  const result = resolveRoleForUid(role, userUid ?? null, isFounderUid);
  if (result.kind === 'catalog' || result.kind === 'legacy') {
    return catalogTitle(result.key);
  }
  const customTitle = customDisplayTitle(role, definitions);
  if (customTitle) return customTitle;
  return 'Guest';
}

/** President check: founder UID, or the resolved key is president_national. */
export function isPresident(userRole: UserRole, userUid: string): boolean {
  if (isFounderUid(userUid)) return true;
  return resolveFor(userRole, userUid) === 'president_national';
}

/**
 * Platform-root check (spec A.5): the Founder by UID, or the resolved
 * chief_technology_officer key. The stored string 'superadmin' grants
 * nothing by itself; it only resolves to the CTO key for read paths that
 * go through resolution, and authority checks use this function.
 */
export function isSuperAdmin(userRole: UserRole | null, userUid: string): boolean {
  if (isFounderUid(userUid)) return true;
  if (!userRole) return false;
  return resolveFor(userRole, userUid) === 'chief_technology_officer';
}

/** Recruitment admin access: founder-grade keys and the National President. */
export function hasRecruitmentAccess(userRole: UserRole): boolean {
  const key = resolveFor(userRole);
  return key === 'president_national' || key === 'chief_technology_officer';
}

/**
 * Site-wide Admin navigation: any resolved role whose catalog scope is
 * global or national (R5/R4/R3). Chapter and General Body roles do not
 * get site-wide admin from this helper; dynamic permission grants are
 * layered by the permission system at the component level.
 */
export function hasSiteAdminAccess(userRole: UserRole): boolean {
  const key = resolveFor(userRole);
  if (!key) return false;
  const scope = scopeOf(key);
  return scope === 'global' || scope === 'national';
}

/**
 * Corrected legacy map (spec A.3): raw token -> catalog key. Scope is
 * never stored here; it is scopeOf(target). Shape changed in Phase 1 from
 * { role, scope } pairs (two divergent taxonomies) to the single catalog
 * target.
 */
export { LEGACY_TO_CATALOG as LEGACY_ROLE_MAP } from './role-catalog';

/**
 * Normalizes a raw role string to its catalog key. Unresolvable tokens
 * return the floor catalog key member_basic ONLY as a display-safe floor;
 * authority code must use resolveRole / normalizeToCanonical, which return
 * the unresolved sentinel instead of a guessed role.
 */
export function normalizeUserRole(rawRole: string | undefined | null): CanonicalRole {
  const key = normalizeToCanonical(rawRole ?? null);
  return (key ?? 'member_basic') as CanonicalRole;
}

/* Resolves the legacy two-value operational scope. The Founder's stored
   'admin' token keeps the national-equivalent scope verified live in
   commit 1757352; authority resolution for 'admin' is resolveRoleForUid. */
export function resolveUserScope(rawRole: string | undefined | null): RoleScope {
  if (!rawRole) return 'chapter';
  const clean = String(rawRole).toLowerCase().trim();
  if (clean === 'admin') return 'national';
  const key = normalizeToCanonical(clean);
  if (!key) return 'chapter';
  const scope = scopeOf(key);
  return scope === 'global' || scope === 'national' ? 'national' : 'chapter';
}

/* Permission gate helpers. Inputs are resolved defensively: an
   unresolvable token (including any pre-Phase-1 invented key) is never an
   executive or a lead. */
export function isNationalExecutive(role: CanonicalRole): boolean {
  const key = normalizeToCanonical(role);
  if (!key) return false;
  const rank = rankOf(key);
  return rank === 'R5' || rank === 'R4' || rank === 'R3';
}

export function isChapterExecutive(role: CanonicalRole): boolean {
  const key = normalizeToCanonical(role);
  if (!key) return false;
  return rankOf(key) === 'R2';
}

export function isSubsystemLead(role: CanonicalRole): boolean {
  const key = normalizeToCanonical(role);
  return key === 'team_lead' || key === 'cubesat_team' || key === 'rocketry_team' || key === 'rover_team';
}

export function canCreateTasks(role: CanonicalRole): boolean {
  return isNationalExecutive(role) || isChapterExecutive(role) || isSubsystemLead(role);
}

export function canReviewTasks(role: CanonicalRole): boolean {
  return isNationalExecutive(role) || isChapterExecutive(role);
}

/** Canonical role titles, derived from the catalog. */
export const CANONICAL_ROLE_TITLES: Record<string, string> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, r.title]),
);

/** Resolved catalog key for a raw token, or the member_basic floor. */
export function resolveCanonicalRole(role: string | null | undefined): CanonicalRole {
  return normalizeUserRole(role);
}

/**
 * Title lookup that never throws: catalog and legacy tokens render their
 * catalog title; a custom slug renders its definition title when the
 * caller supplies a valid definition, otherwise the s.4.5 step 5
 * humanised floor (never the raw slug); anything else falls back to the
 * raw token, and empty input renders 'Guest'. Non-custom output is
 * byte-identical to before.
 */
export function canonicalRoleTitle(
  role: string | null | undefined,
  definitions?: CustomRoleDefinitionsMap,
): string {
  if (!role || typeof role !== 'string') return 'Guest';
  const key = resolveFor(role);
  if (key) return catalogTitle(key);
  const customTitle = customDisplayTitle(role, definitions);
  if (customTitle) return customTitle;
  const raw = role.trim();
  return raw || 'Guest';
}

/**
 * Format a delegation-engine user label:
 * [Scope] Full Name (Catalog Title - Subsystem)
 * Scope renders 'National' for global/national catalog scopes, otherwise
 * the chapter slug uppercased. (The workstream C resolver replaces the
 * scope derivation here; see src/lib/scope.ts.)
 */
export function formatCanonicalUserLabel(user: {
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  chapterId?: string | null;
  subsystem?: string | null;
}): string {
  const name = (user.displayName || '').trim() || (user.email || '').trim() || 'Unknown user';
  const key = resolveFor(user.role ?? null);
  const title = canonicalRoleTitle(user.role);
  const scope = key ? scopeOf(key) : 'none';
  const chapterSlug = (user.chapterId || '').trim();
  const scopeLabel =
    scope === 'global' || scope === 'national'
      ? 'National'
      : chapterSlug
        ? chapterSlug.toUpperCase()
        : 'CHAPTER';
  const subsystem = (user.subsystem || '').trim();
  const parenthetical = subsystem ? `${title} - ${subsystem}` : title;
  return `[${scopeLabel}] ${name} (${parenthetical})`;
}
