/**
 * Migration remap table (Phase 1, spec M.1/M.2) - a generated view over
 * src/lib/role-catalog.ts. There is no second hand-maintained map: every
 * disposition derives from resolveRole / LEGACY_TO_CATALOG, plus the two
 * decision-gated branches (abolished keys, founder record) and the manual
 * census list.
 */

import {
  LEGACY_TO_CATALOG,
  ABOLISHED_KEYS,
  resolveRole,
  normalizeRoleSlug,
  type CatalogRoleKey,
} from '../../src/lib/role-catalog';

export type Disposition =
  | { kind: 'catalog-identity'; target: CatalogRoleKey }
  | { kind: 'map'; target: CatalogRoleKey; via: 'block1' | 'block2' }
  | { kind: 'founder-admin'; target: 'founder_patron' }
  | { kind: 'abolished-branch'; block1Target: CatalogRoleKey }
  | { kind: 'manual' }
  | { kind: 'fallback'; target: 'member_basic' };

/**
 * Tokens with no catalog standing whose holders need a human decision
 * (spec M.1 census): the invented national_vp_* / chapter_vp_* families,
 * the subsystem lead_* tokens, senior_advisor, and team_member. These are
 * report-only in every plan; they are never auto-remapped and never
 * silently floored.
 */
export const MANUAL_TOKENS: ReadonlySet<string> = new Set([
  'national_vp_engineering',
  'national_vp_operations',
  'national_vp_marketing',
  'national_vp_finance',
  'national_vp_membership',
  'chapter_vp_technical',
  'chapter_vp_operations',
  'chapter_vp_marketing',
  'lead_propulsion',
  'lead_structures',
  'lead_avionics',
  'lead_robotics',
  'lead_materials',
  'lead_ground_systems',
  'senior_advisor',
  'team_member',
]);

const BLOCK1_KEYS: ReadonlySet<string> = new Set([
  'president_chapter', 'president_national', 'vice_president',
  'national_vice_president', 'superadmin', 'general_secretary',
  'national_marketing', 'chair_marketing', 'marketing_head',
  'projects_director', 'chair_projects', 'hr_director',
  'chair_recruitment', 'chair_ethics', 'chair_sponsorship', 'treasurer',
  'chair_design', 'chair_events', 'chair_outreach', 'chair_alumni',
  'ambassador_seds', 'advisor', 'website_developer', 'member',
]);

export function dispositionFor(
  token: string | null | undefined,
  uid: string,
  isFounder: (uid: string) => boolean,
): Disposition {
  if (token === null || token === undefined || String(token).trim() === '') {
    return { kind: 'fallback', target: 'member_basic' };
  }
  const clean = normalizeRoleSlug(String(token));
  if (clean === 'admin') {
    if (isFounder(uid)) return { kind: 'founder-admin', target: 'founder_patron' };
    return { kind: 'fallback', target: 'member_basic' };
  }
  if (MANUAL_TOKENS.has(clean)) return { kind: 'manual' };
  if ((ABOLISHED_KEYS as readonly string[]).includes(clean)) {
    return { kind: 'abolished-branch', block1Target: LEGACY_TO_CATALOG[clean] };
  }
  const result = resolveRole(clean);
  if (result.kind === 'catalog') return { kind: 'catalog-identity', target: result.key };
  if (result.kind === 'legacy') {
    return {
      kind: 'map',
      target: result.key,
      via: BLOCK1_KEYS.has(result.formerKey) ? 'block1' : 'block2',
    };
  }
  // 'none', statuses stored as roles, and every other unresolvable value:
  // the M.3 floor. Never guest (guest is nobody's membership state).
  return { kind: 'fallback', target: 'member_basic' };
}
