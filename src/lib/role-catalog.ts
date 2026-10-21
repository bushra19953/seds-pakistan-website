/**
 * Role Catalog - the single source of truth for roles (Phase 1, spec A).
 *
 * Exactly one table of 40 role keys exists in code: ROLE_CATALOG below,
 * transcribed from the Role Catalog docx (Articles 5-9). Every other role
 * list in the repo is a derivation of this table, a legacy input map
 * (LEGACY_TO_CATALOG), or is deleted. XP is a property of the role, read
 * from this table only; it is never a stored balance (site points are a
 * different system and are never renamed, capped, or merged into XP).
 *
 * This module has zero imports so client components, server routes, PDF
 * code, the seed script, and the test suite can all import it without
 * cycles, and so it can be mechanically diffed against spec A.1.
 */

export type AuthorityRank = 'R5' | 'R4' | 'R3' | 'R2' | 'R1' | 'R0';
export type RoleCategory = 'A' | 'B' | 'C' | 'D' | 'GENERAL_BODY';
export type CatalogScope = 'global' | 'national' | 'chapter' | 'none';
export type AppointingAuthority =
  | 'FOUNDER'
  | 'BOARD'
  | 'GOVERNORS'
  | 'FULL_MEMBERS'
  | 'NATIONAL_PRESIDENT'
  | 'CHIEF_TECHNOLOGY_OFFICER'
  | 'NATIONAL_PROJECTS_DIRECTOR'
  | 'NONE_LIFE_TENURE'
  | 'NOT_APPLICABLE';

export type CatalogRoleKey =
  | 'founder_patron'
  | 'governor_founder'
  | 'governor_coopted'
  | 'governor_member'
  | 'executive_director'
  | 'president_national'
  | 'national_vice_president'
  | 'national_general_secretary'
  | 'national_treasurer'
  | 'national_marketing_director'
  | 'national_projects_director'
  | 'national_membership_director'
  | 'national_audit_compliance_chair'
  | 'chief_technology_officer'
  | 'chapter_president'
  | 'chapter_vice_president'
  | 'chapter_secretary'
  | 'chapter_treasurer'
  | 'chapter_representative'
  | 'regional_coordinator'
  | 'chapter_marketing_chair'
  | 'chapter_projects_chair'
  | 'chapter_events_chair'
  | 'chapter_outreach_chair'
  | 'chapter_recruitment_chair'
  | 'chapter_finance_chair'
  | 'chapter_design_chair'
  | 'chapter_alumni_chair'
  | 'faculty_advisor'
  | 'parliamentarian'
  | 'returning_officer'
  | 'platform_developer'
  | 'team_lead'
  | 'cubesat_team'
  | 'rocketry_team'
  | 'rover_team'
  | 'member'
  | 'member_officer'
  | 'member_advisor'
  | 'member_basic';

export interface CatalogRole {
  key: CatalogRoleKey;
  title: string;
  rank: AuthorityRank;
  xp: number;
  category: RoleCategory;
  scope: CatalogScope;
  appointedBy: AppointingAuthority;
  ratifiedByBoard: boolean;
  seats: number | 'multi' | null;
  seatsNote?: string;
  voting: 'veto' | 'yes' | 'general_body_powers' | 'no';
  /** True only for member_officer: a computed label (Art. 9.4), never stored as a primary role. */
  derived?: boolean;
}

/**
 * The 40 catalog rows, in spec A.1 order. Rank, XP, title, appointed-by
 * and Category A seats are docx values verbatim; scope is derived from
 * rank (R5/R4 global, R3 national, R2 chapter, R1/R0 none); seats for
 * Categories B, C, D are the spec's marked inferences.
 */
export const ROLE_CATALOG: readonly CatalogRole[] = [
  { key: 'founder_patron', title: 'Founder and Patron-in-Chief', rank: 'R5', xp: 35, category: 'A', scope: 'global', appointedBy: 'NONE_LIFE_TENURE', ratifiedByBoard: false, seats: 1, voting: 'veto' },
  { key: 'governor_founder', title: 'Founder-Appointed Governor', rank: 'R4', xp: 30, category: 'A', scope: 'global', appointedBy: 'FOUNDER', ratifiedByBoard: false, seats: 4, voting: 'yes' },
  { key: 'governor_coopted', title: 'Co-opted Governor', rank: 'R4', xp: 28, category: 'A', scope: 'global', appointedBy: 'GOVERNORS', ratifiedByBoard: false, seats: 2, voting: 'yes' },
  { key: 'governor_member', title: 'Member Governor', rank: 'R4', xp: 28, category: 'A', scope: 'global', appointedBy: 'FULL_MEMBERS', ratifiedByBoard: false, seats: 2, voting: 'yes' },
  { key: 'executive_director', title: 'Executive Director', rank: 'R3', xp: 26, category: 'B', scope: 'national', appointedBy: 'BOARD', ratifiedByBoard: false, seats: 1, voting: 'yes' },
  { key: 'president_national', title: 'National President', rank: 'R3', xp: 25, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_vice_president', title: 'National Vice President', rank: 'R3', xp: 23, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_general_secretary', title: 'National General Secretary', rank: 'R3', xp: 23, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_treasurer', title: 'National Treasurer', rank: 'R3', xp: 23, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_marketing_director', title: 'National Marketing Director', rank: 'R3', xp: 21, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_projects_director', title: 'National Projects Director', rank: 'R3', xp: 21, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_membership_director', title: 'National Membership Director', rank: 'R3', xp: 20, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'national_audit_compliance_chair', title: 'National Audit and Compliance Chair', rank: 'R3', xp: 20, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'chief_technology_officer', title: 'Chief Technology Officer', rank: 'R3', xp: 20, category: 'B', scope: 'national', appointedBy: 'FOUNDER', ratifiedByBoard: true, seats: 1, voting: 'yes' },
  { key: 'chapter_president', title: 'Chapter President', rank: 'R2', xp: 18, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_vice_president', title: 'Chapter Vice President', rank: 'R2', xp: 16, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_secretary', title: 'Chapter Secretary', rank: 'R2', xp: 15, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_treasurer', title: 'Chapter Treasurer', rank: 'R2', xp: 15, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_representative', title: 'National Chapter Representative', rank: 'R2', xp: 14, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'regional_coordinator', title: 'Regional Coordinator', rank: 'R2', xp: 14, category: 'C', scope: 'chapter', appointedBy: 'FOUNDER', ratifiedByBoard: false, seats: 1, seatsNote: 'per region', voting: 'yes' },
  { key: 'chapter_marketing_chair', title: 'Chapter Marketing Chair', rank: 'R2', xp: 12, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_projects_chair', title: 'Chapter Projects Chair', rank: 'R2', xp: 12, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_events_chair', title: 'Chapter Events Chair', rank: 'R2', xp: 11, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_outreach_chair', title: 'Chapter Outreach Chair', rank: 'R2', xp: 11, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_recruitment_chair', title: 'Chapter Recruitment Chair', rank: 'R2', xp: 10, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_finance_chair', title: 'Chapter Finance Chair', rank: 'R2', xp: 10, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_design_chair', title: 'Chapter Design and Media Chair', rank: 'R2', xp: 9, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'chapter_alumni_chair', title: 'Chapter Alumni Chair', rank: 'R2', xp: 8, category: 'C', scope: 'chapter', appointedBy: 'NATIONAL_PRESIDENT', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'yes' },
  { key: 'faculty_advisor', title: 'Faculty Advisor', rank: 'R1', xp: 8, category: 'D', scope: 'none', appointedBy: 'FOUNDER', ratifiedByBoard: false, seats: 1, seatsNote: 'per chapter', voting: 'no' },
  { key: 'parliamentarian', title: 'Parliamentarian', rank: 'R1', xp: 8, category: 'D', scope: 'none', appointedBy: 'FOUNDER', ratifiedByBoard: false, seats: 1, voting: 'no' },
  { key: 'returning_officer', title: 'Returning Officer', rank: 'R1', xp: 8, category: 'D', scope: 'none', appointedBy: 'FOUNDER', ratifiedByBoard: false, seats: 1, voting: 'no' },
  { key: 'platform_developer', title: 'Platform Developer', rank: 'R1', xp: 6, category: 'D', scope: 'none', appointedBy: 'CHIEF_TECHNOLOGY_OFFICER', ratifiedByBoard: false, seats: 'multi', voting: 'no' },
  { key: 'team_lead', title: 'Team Lead', rank: 'R1', xp: 5, category: 'D', scope: 'none', appointedBy: 'NATIONAL_PROJECTS_DIRECTOR', ratifiedByBoard: false, seats: 1, seatsNote: 'per unit', voting: 'no' },
  { key: 'cubesat_team', title: 'CubeSat and CanSat Unit', rank: 'R1', xp: 4, category: 'D', scope: 'none', appointedBy: 'NATIONAL_PROJECTS_DIRECTOR', ratifiedByBoard: false, seats: 'multi', seatsNote: 'unit', voting: 'no' },
  { key: 'rocketry_team', title: 'Rocketry Unit', rank: 'R1', xp: 4, category: 'D', scope: 'none', appointedBy: 'NATIONAL_PROJECTS_DIRECTOR', ratifiedByBoard: false, seats: 'multi', seatsNote: 'unit', voting: 'no' },
  { key: 'rover_team', title: 'Rover Unit', rank: 'R1', xp: 4, category: 'D', scope: 'none', appointedBy: 'NATIONAL_PROJECTS_DIRECTOR', ratifiedByBoard: false, seats: 'multi', seatsNote: 'unit', voting: 'no' },
  { key: 'member', title: 'Full Member', rank: 'R0', xp: 3, category: 'GENERAL_BODY', scope: 'none', appointedBy: 'NOT_APPLICABLE', ratifiedByBoard: false, seats: 'multi', voting: 'general_body_powers' },
  { key: 'member_officer', title: 'Officer Member', rank: 'R0', xp: 3, category: 'GENERAL_BODY', scope: 'none', appointedBy: 'NOT_APPLICABLE', ratifiedByBoard: false, seats: 'multi', voting: 'general_body_powers', derived: true },
  { key: 'member_advisor', title: 'Non-Student Advisor', rank: 'R0', xp: 2, category: 'GENERAL_BODY', scope: 'none', appointedBy: 'NOT_APPLICABLE', ratifiedByBoard: false, seats: 'multi', voting: 'no' },
  { key: 'member_basic', title: 'Basic Member', rank: 'R0', xp: 1, category: 'GENERAL_BODY', scope: 'none', appointedBy: 'NOT_APPLICABLE', ratifiedByBoard: false, seats: 'multi', voting: 'no' },
];

export const CATALOG_ROLE_KEYS: readonly CatalogRoleKey[] = ROLE_CATALOG.map((r) => r.key);

/** Record form of the catalog (consumed by workstream C and Phase 2/3 crews). */
export const CANONICAL_ROLES: Record<CatalogRoleKey, CatalogRole> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, r]),
) as Record<CatalogRoleKey, CatalogRole>;

// Compile-time exhaustiveness: if a key is added to CatalogRoleKey without a
// catalog row (or vice versa), this assignment fails typecheck.
const _catalogExhaustive: Record<CatalogRoleKey, CatalogRole> = CANONICAL_ROLES;
void _catalogExhaustive;

const CATALOG_KEY_SET: ReadonlySet<string> = new Set(CATALOG_ROLE_KEYS);

export function isCatalogRoleKey(value: unknown): value is CatalogRoleKey {
  return typeof value === 'string' && CATALOG_KEY_SET.has(value);
}

export function getCatalogRole(key: CatalogRoleKey): CatalogRole {
  return CANONICAL_ROLES[key];
}

export function catalogTitle(key: CatalogRoleKey): string {
  return CANONICAL_ROLES[key].title;
}

export function rankOf(key: CatalogRoleKey): AuthorityRank {
  return CANONICAL_ROLES[key].rank;
}

export function xpOf(key: CatalogRoleKey): number {
  return CANONICAL_ROLES[key].xp;
}

export function scopeOf(key: CatalogRoleKey): CatalogScope {
  return CANONICAL_ROLES[key].scope;
}

export function appointedByOf(key: CatalogRoleKey): AppointingAuthority {
  return CANONICAL_ROLES[key].appointedBy;
}

/** Numeric rank for comparison: R5 = 5 ... R0 = 0. */
export function rankValue(rank: AuthorityRank): number {
  return Number(rank.slice(1));
}

/** XP of the highest-ranked held role (Art. 4.5); ties break by higher XP. */
export function xpForRoles(keys: readonly CatalogRoleKey[]): number {
  let best: CatalogRole | null = null;
  for (const key of keys) {
    const role = CANONICAL_ROLES[key];
    if (!role) continue;
    if (
      !best ||
      rankValue(role.rank) > rankValue(best.rank) ||
      (role.rank === best.rank && role.xp > best.xp)
    ) {
      best = role;
    }
  }
  return best ? best.xp : 0;
}

/**
 * The B.1 effective-role derivation, shared by the write path, the read
 * helper, and reconciliation: highest rankOf; ties by higher xpOf, then
 * primary first, then key ascending.
 */
export function effectiveRoleOf(
  role: CatalogRoleKey,
  additionalRoles: readonly CatalogRoleKey[],
): CatalogRoleKey {
  let best = role;
  for (const candidate of additionalRoles) {
    if (candidate === best) continue;
    const candRank = rankValue(rankOf(candidate));
    const bestRank = rankValue(rankOf(best));
    if (candRank > bestRank) {
      best = candidate;
    } else if (candRank === bestRank) {
      const candXp = xpOf(candidate);
      const bestXp = xpOf(best);
      if (candXp > bestXp) {
        best = candidate;
      } else if (candXp === bestXp && candidate !== role && candidate < best) {
        best = candidate;
      }
    }
  }
  return best;
}

/** Deterministic stored form for additionalRoles: deduped, primary excluded, rank desc then key asc. */
export function sortAdditionalRoles(
  primary: CatalogRoleKey,
  additionalRoles: readonly string[],
): CatalogRoleKey[] {
  const seen = new Set<CatalogRoleKey>();
  for (const raw of additionalRoles) {
    if (isCatalogRoleKey(raw) && raw !== primary) seen.add(raw);
  }
  return [...seen].sort((a, b) => {
    const byRank = rankValue(rankOf(b)) - rankValue(rankOf(a));
    if (byRank !== 0) return byRank;
    const byXp = xpOf(b) - xpOf(a);
    if (byXp !== 0) return byXp;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Slug hygiene only: lowercase, non-alphanumeric to underscore, collapse,
 * strip. No semantic redirects live here (spec A.2 item 3).
 */
export function normalizeRoleSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The four keys abolished by Catalog Art. 12.3 (see ABOLISHED_KEYS_RELEASE). */
export const ABOLISHED_KEYS: readonly string[] = [
  'vice_president',
  'chair_marketing',
  'marketing_head',
  'chair_projects',
];

/**
 * Decision-gated (Section 02 D2): Art. 12.3/12.5 release vs Art. 12.1/12.4
 * migration. Default false = abolished keys still resolve via Block 1 in
 * staging. Flips only on Zubair's recorded ruling; this flag and its value
 * are part of the deploy checklist, never a silent production default.
 */
export const ABOLISHED_KEYS_RELEASE = false;

/**
 * Code constant (R.2): after the stored-role migration (M apply) completes,
 * legacy resolution narrows to the corrected map only. Security posture
 * changes ship through code review, never a settings edit.
 */
export const LEGACY_RESOLUTION_NARROWED = false;

/**
 * LEGACY_TO_CATALOG. Block 1 is Catalog Art. 12.1 verbatim (24 former keys).
 * Block 2 is site-only aliases with no catalog standing, kept solely so
 * stored tokens in live docs resolve during Phase 1; every Block 2 entry is
 * listed in the migration report and Block 2 is deleted when the stored-role
 * migration completes. Scope is never stored in this map: it is
 * scopeOf(target). `admin` is deliberately NOT a map entry: it is founder
 * handling, resolved by resolveRole against the founder UID (see
 * resolveRoleForUid).
 */
export const LEGACY_TO_CATALOG: Record<string, CatalogRoleKey> = {
  // Block 1 - Art. 12.1
  president_chapter: 'chapter_president',
  president_national: 'president_national',
  vice_president: 'national_vice_president',
  national_vice_president: 'national_vice_president',
  superadmin: 'chief_technology_officer',
  general_secretary: 'national_general_secretary',
  national_marketing: 'national_marketing_director',
  chair_marketing: 'national_marketing_director',
  marketing_head: 'national_marketing_director',
  projects_director: 'national_projects_director',
  chair_projects: 'chapter_projects_chair',
  hr_director: 'national_membership_director',
  chair_recruitment: 'chapter_recruitment_chair',
  chair_ethics: 'national_audit_compliance_chair',
  chair_sponsorship: 'chapter_finance_chair',
  treasurer: 'chapter_treasurer',
  chair_design: 'chapter_design_chair',
  chair_events: 'chapter_events_chair',
  chair_outreach: 'chapter_outreach_chair',
  chair_alumni: 'chapter_alumni_chair',
  ambassador_seds: 'regional_coordinator',
  advisor: 'faculty_advisor',
  website_developer: 'platform_developer',
  member: 'member',
  // Block 2 - site-only aliases (removal condition: stored-role migration complete)
  president: 'president_national',
  vp: 'national_vice_president',
  secretary: 'chapter_secretary',
  director: 'national_projects_director',
  head: 'national_projects_director',
  team_leader: 'team_lead',
  lead: 'team_lead',
  chair: 'team_lead',
  developer: 'platform_developer',
  super_admin: 'chief_technology_officer',
  pakistan_president: 'president_national',
  pakistan_national_president: 'president_national',
  presidential_national: 'president_national',
  marketing_lead: 'national_marketing_director',
  marketingoutreach_head: 'national_marketing_director',
  chair_marketing_communications: 'national_marketing_director',
  chair_projects_committee: 'chapter_projects_chair',
  hr_or_membership_director: 'national_membership_director',
  chair_recruitment_membership: 'chapter_recruitment_chair',
  chair_design_media: 'chapter_design_chair',
  chair_ethics_sustainability: 'national_audit_compliance_chair',
  chair_events_committee: 'chapter_events_chair',
  chair_outreach_committee: 'chapter_outreach_chair',
  chair_sponsorship_finance: 'chapter_finance_chair',
  chair_alumni_legacy_network: 'chapter_alumni_chair',
  advisor_faculty_head: 'faculty_advisor',
  cubesatcansat_team: 'cubesat_team',
  chapter_faculty_advisor: 'faculty_advisor',
  chapter_general_secretary: 'chapter_secretary',
};

export type ResolveResult =
  | { kind: 'catalog'; key: CatalogRoleKey }
  | { kind: 'legacy'; key: CatalogRoleKey; formerKey: string }
  | { kind: 'abolished'; formerKey: string }
  | { kind: 'unknown'; raw: string | null };

/**
 * Resolve a raw stored token. No silent fallback: unmapped tokens return
 * the "unknown" sentinel. Invented site tokens (national_vp_*,
 * chapter_vp_*, lead_*, senior_advisor, team_member, statuses stored as
 * roles, etc.) are deliberately NOT mapped (spec A.3): their holders
 * surface in the migration census for manual re-appointment.
 */
export function resolveRole(raw: string | null | undefined): ResolveResult {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { kind: 'unknown', raw: raw ?? null };
  }
  const clean = normalizeRoleSlug(String(raw));
  if (clean === '') return { kind: 'unknown', raw: String(raw) };
  if (ABOLISHED_KEYS_RELEASE && ABOLISHED_KEYS.includes(clean)) {
    return { kind: 'abolished', formerKey: clean };
  }
  if (isCatalogRoleKey(clean)) return { kind: 'catalog', key: clean };
  const target = LEGACY_TO_CATALOG[clean];
  if (target) return { kind: 'legacy', key: target, formerKey: clean };
  return { kind: 'unknown', raw: String(raw) };
}

/**
 * Founder-aware resolution: the stored token `admin` on the Founder's own
 * doc means founder_patron; on any other uid it is unresolved (spec A.3
 * Block 2). All other tokens resolve exactly as resolveRole.
 */
export function resolveRoleForUid(
  raw: string | null | undefined,
  uid: string | null | undefined,
  isFounder: (uid: string | null | undefined) => boolean,
): ResolveResult {
  if (raw && normalizeRoleSlug(String(raw)) === 'admin') {
    if (uid && isFounder(uid)) return { kind: 'catalog', key: 'founder_patron' };
    return { kind: 'unknown', raw: String(raw) };
  }
  return resolveRole(raw);
}

/** The only normalizer scope/authority consumers may use: null for abolished and unknown. */
export function normalizeToCanonical(raw: string | null | undefined): CatalogRoleKey | null {
  const result = resolveRole(raw);
  if (result.kind === 'catalog' || result.kind === 'legacy') return result.key;
  return null;
}

/**
 * The founder's public title wording, as ONE constant (spec A.6). The
 * catalog docx says "Founder and Patron-in-Chief"; the Constitution says
 * "Founding Patron-in-Chief" (FLAG-DOCX-2). The final value is Decision 4;
 * no other file may hardcode either form.
 */
export const FOUNDER_DISPLAY_TITLE = 'Founder and Patron-in-Chief';

/** Maximum customTitle length, unified across API and UIs (spec A.6). */
export const CUSTOM_TITLE_MAX_LENGTH = 80;

/**
 * Reserved titles for customTitle validation (spec A.6): the 40 catalog
 * titles plus office words. A customTitle may never carry one of these.
 */
export const RESERVED_TITLES: readonly string[] = [
  ...ROLE_CATALOG.map((r) => r.title),
  'Founder',
  'Patron-in-Chief',
  'Founding Patron-in-Chief',
  'Governor',
  'President',
  'National President',
  'Pakistan President',
  'Super Admin',
];

const RESERVED_TITLE_SET: ReadonlySet<string> = new Set(
  RESERVED_TITLES.map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim()),
);

export function isReservedTitle(value: string): boolean {
  if (typeof value !== 'string') return false;
  let normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  // Strip a trailing parenthetical before the equality check (spec A.6).
  const parenIdx = normalized.indexOf(' (');
  if (parenIdx > 0) normalized = normalized.slice(0, parenIdx).trim();
  if (normalized === '') return false;
  if (RESERVED_TITLE_SET.has(normalized)) return true;
  // Substring rule for patron / governor only (spec A.6).
  if (normalized.includes('patron') || normalized.includes('governor')) return true;
  return false;
}
