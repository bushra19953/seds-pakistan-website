/**
 * lifecycle-appointer-map.ts - Phase 2 Section D.1: the appointer map.
 *
 * Appointing person as DATA (spec D.1). One entry per role key in the
 * Phase 1 catalog (interface contract: exactly 40 keys, src/lib/role-catalog.ts
 * on the Phase 1 branch), expressed in the extended LifecycleRoleDefinition
 * shape from src/types/lifecycle.ts, plus the two fields the lifecycle brief
 * requires alongside it: who ratifies and who may remove.
 *
 * Authoring sources, in precedence order used here:
 *  1. Spec Section D.1's appointer table (the lifecycle spec's own map).
 *  2. The Phase 1 catalog rows (category, seats, appointedBy) where D.1 is
 *     silent or uses a different role name for the same office.
 * Every entry where the two sources disagree carries an appointerNote naming
 * the disagreement, so integration can flip a single data row, not code.
 *
 * Known divergences (flagged, not silently resolved):
 *  - Category B officers: D.1 lists the appointer as "Board (FP interim)";
 *    the Phase 1 catalog lists appointedBy FOUNDER with ratifiedByBoard true.
 *    These are the same fact read at two instants: pre-Board, the Founder
 *    appoints and the 30-day Board ratification window (D.4) runs; once the
 *    Board is seated it appoints directly and NO ratification record is
 *    created (D.4). The map therefore records appointingRoleKeys =
 *    [founder_appointer] for founder-appointed Category B roles and
 *    ratifierRoleKey = board_of_governors; the ratification module applies
 *    the D.4 rule (ratification record only when founder-appointed).
 *  - Chapter officers below President: D.1 gives the Chapter President as
 *    appointer; the Phase 1 catalog gives NATIONAL_PRESIDENT. D.1 wins here
 *    (it is the lifecycle spec's authored map); the catalog value is named
 *    in each affected entry's appointerNote.
 *  - regional_coordinator: Category C with a Board appointer is the D.1
 *    EXCEPTION (Art. 8.5), pinned by test T1. The Phase 1 catalog says
 *    FOUNDER; D.1's exception is the later, deliberate ruling and wins.
 *  - governor_founder: D.1 "President (Council), electors (Board)"; the
 *    catalog says FOUNDER. Recorded as founder_appointer (the Founder is
 *    the only separate interim authority, Section 0 contract 4).
 *  - governor_member: elected by Full Members (catalog FULL_MEMBERS); D.1
 *    records the Board (FP interim) as the recording appointer. An elected
 *    seat has no appointive remover and the Founder may NOT fill it by
 *    fallback (D.8.1); removerRoleKeys is therefore empty.
 *  - founder_appointer (D.1's self-referential row, the only entry whose
 *    defaultAppointer is true) is NOT a catalog role: it is the sentinel
 *    appointer key FOUNDER_APPOINTER_KEY in src/types/lifecycle.ts, so it
 *    has no map entry. Consequently no entry below sets defaultAppointer;
 *    the authoring-time assertion is that the sentinel is the unique
 *    default appointer (test T1).
 *  - cadet (D.1 row, appointer National Membership Director) is not one of
 *    the contract's 40 catalog keys; it lives in
 *    SECTION_D_SUPPLEMENTARY_APPOINTER_MAP with the other Section D
 *    vocabulary names that have no catalog key, so Section D consumers
 *    (vacancy seats, restore routing) still resolve them. The guard fails
 *    CLOSED for any key in neither map (ROLE_CATALOG_INCOMPLETE, D.1).
 *
 * Remover rule: the D.2 guard applies the appointer match to 'appoint',
 * 'revoke' and 'demote' alike, so removerRoleKeys defaults to the
 * appointingRoleKeys. Exceptions: founder_patron (life tenure, catalog
 * NONE_LIFE_TENURE - no remover), governor_member (elected - no appointive
 * remover), member_officer (derived label, never held directly).
 *
 * This module is pure data + lookups: zero imports beyond types, no I/O.
 */

import {
  BOARD_APPOINTER_KEY,
  FOUNDER_APPOINTER_KEY,
  type LifecycleRoleDefinition,
} from '@/types/lifecycle';

export interface AppointerMapEntry extends LifecycleRoleDefinition {
  /** Who ratifies the appointment (Board for Category B), or null. */
  ratifierRoleKey: string | null;
  /** Role keys whose holders may revoke/remove an appointment to this role. */
  removerRoleKeys: string[];
}

const BOARD = BOARD_APPOINTER_KEY;
const FOUNDER = FOUNDER_APPOINTER_KEY;
const NATIONAL_PRESIDENT = 'president_national';
const CHAPTER_PRESIDENT = 'chapter_president';
const NATIONAL_MEMBERSHIP_DIRECTOR = 'national_membership_director';
const NATIONAL_MARKETING_DIRECTOR = 'national_marketing_director';
const NATIONAL_PROJECTS_DIRECTOR = 'national_projects_director';
const CHIEF_TECHNOLOGY_OFFICER = 'chief_technology_officer';

type EntrySeed = Omit<AppointerMapEntry, 'removerRoleKeys' | 'ratifierRoleKey'> & {
  ratifierRoleKey?: string | null;
  removerRoleKeys?: string[];
};

function entry(seed: EntrySeed): AppointerMapEntry {
  return {
    ratifierRoleKey: null,
    ...seed,
    removerRoleKeys: seed.removerRoleKeys ?? [...seed.appointingRoleKeys],
  };
}

function boardAppointedB(seed: Omit<EntrySeed, 'category' | 'tier' | 'chapterScoped' | 'ratificationRequired' | 'minimumMembershipClassForFullPowers'>): AppointerMapEntry {
  // Category B national officer, founder-appointed pre-Board (see header).
  return entry({
    category: 'B',
    tier: 'fullOfficer',
    chapterScoped: false,
    ratificationRequired: true,
    minimumMembershipClassForFullPowers: 'Full',
    ratifierRoleKey: BOARD,
    ...seed,
  });
}

function chapterOfficer(seed: Omit<EntrySeed, 'category' | 'tier' | 'chapterScoped' | 'ratificationRequired' | 'minimumMembershipClassForFullPowers'>): AppointerMapEntry {
  // Category C chapter office: Chapter President appoints (D.1); a
  // Provisional member may hold it with powers deferred (D.3 soft tier).
  return entry({
    category: 'C',
    tier: 'fullOfficer',
    chapterScoped: true,
    ratificationRequired: false,
    minimumMembershipClassForFullPowers: 'Provisional',
    ...seed,
  });
}

const CATALOG_DIVERGENCE_NOTE =
  'Section D.1 appointer; Phase 1 catalog records NATIONAL_PRESIDENT (divergence flagged in lifecycle-appointer-map header).';

/**
 * The appointer map for the 40 Phase 1 catalog keys, in catalog order.
 */
export const APPOINTER_MAP: readonly AppointerMapEntry[] = [
  // -- Category A ------------------------------------------------------------
  entry({
    key: 'founder_patron',
    category: 'A',
    tier: 'none',
    chapterScoped: false,
    appointingRoleKeys: [FOUNDER],
    appointerNote:
      'Life tenure (catalog NONE_LIFE_TENURE). The Founder holds this office; founder_appointer is recorded as its appointer per D.1.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [],
  }),
  entry({
    key: 'governor_founder',
    category: 'A',
    tier: 'fullOfficer',
    chapterScoped: false,
    appointingRoleKeys: [FOUNDER],
    appointerNote:
      'D.1: President (Council), electors (Board); Phase 1 catalog: FOUNDER. Recorded as founder_appointer (Section 0 contract 4: the Founder root is the only separate interim authority).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 4,
  }),
  entry({
    key: 'governor_coopted',
    category: 'A',
    tier: 'fullOfficer',
    chapterScoped: false,
    appointingRoleKeys: [BOARD],
    appointerNote: 'Co-opted by the Board / seated Governors (D.1 Board (FP interim); catalog GOVERNORS). Fillable by co-option at any time (D.8.1).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 2,
  }),
  entry({
    key: 'governor_member',
    category: 'A',
    tier: 'fullOfficer',
    chapterScoped: false,
    appointingRoleKeys: [BOARD],
    appointerNote:
      'Elected by Full Members (catalog FULL_MEMBERS); D.1 records Board (FP interim) as the recording appointer. Elected seat: no appointive remover, and the Founder may NOT fill a vacancy by fallback (D.8.1, election_required).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 2,
    removerRoleKeys: [],
  }),

  // -- Category B (founder-appointed, Board-ratified; see header) ------------
  boardAppointedB({
    key: 'executive_director',
    appointingRoleKeys: [BOARD],
    appointerNote:
      'D.1 and the Phase 1 catalog agree: the Board appoints the Executive Director. Board-appointed Category B is NOT ratifiable (D.4: the Board does not ratify its own act); ratificationRequired stays true as the category flag and the ratification module applies the founder-appointed condition.',
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'president_national',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_vice_president',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_general_secretary',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_treasurer',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_marketing_director',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_projects_director',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_membership_director',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'national_audit_compliance_chair',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  boardAppointedB({
    key: 'chief_technology_officer',
    appointingRoleKeys: [FOUNDER],
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),

  // -- Category C ------------------------------------------------------------
  chapterOfficer({
    key: 'chapter_president',
    appointingRoleKeys: [NATIONAL_PRESIDENT],
    appointerNote: 'D.1 and catalog agree: the National President appoints chapter presidents (Art. 7.3, nationally).',
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_vice_president',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_secretary',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: `Section D.1 name: chapter_general_secretary. ${CATALOG_DIVERGENCE_NOTE}`,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_treasurer',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_representative',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote:
      'No direct D.1 row; the closest D.1 rows (chapter_coordinator, chapter_ambassador) are Chapter President appointees. Phase 1 catalog records NATIONAL_PRESIDENT (divergence flagged).',
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  entry({
    key: 'regional_coordinator',
    category: 'C',
    tier: 'fullOfficer',
    chapterScoped: false,
    appointingRoleKeys: [BOARD],
    appointerNote:
      'D.1 EXCEPTION (Art. 8.5): despite Category C, the appointer is the Board (FP interim). Phase 1 catalog records FOUNDER (divergence flagged). Pinned by test T1.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: 'Provisional',
    ratificationRequired: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
    removerRoleKeys: [BOARD],
  }),
  chapterOfficer({
    key: 'chapter_marketing_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: `Section D.1 analog: chapter_marketing_lead. ${CATALOG_DIVERGENCE_NOTE}`,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_projects_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_events_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_outreach_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: `Section D.1 analog: chapter_outreach_lead. ${CATALOG_DIVERGENCE_NOTE}`,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_recruitment_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_finance_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_design_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_alumni_chair',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: CATALOG_DIVERGENCE_NOTE,
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),

  // -- Catalog Category D / GENERAL_BODY (lifecycle Category C mechanics) ----
  entry({
    key: 'faculty_advisor',
    category: 'C',
    tier: 'none',
    chapterScoped: true,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote:
      'Section D.1 row chapter_advisor (Chapter President appoints). Phase 1 catalog: Category D, appointedBy FOUNDER (divergence flagged).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 1,
  }),
  entry({
    key: 'parliamentarian',
    category: 'C',
    tier: 'none',
    chapterScoped: false,
    appointingRoleKeys: [FOUNDER],
    appointerNote: 'No D.1 row; Phase 1 catalog (Category D): FOUNDER appoints.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 1,
  }),
  entry({
    key: 'returning_officer',
    category: 'C',
    tier: 'none',
    chapterScoped: false,
    appointingRoleKeys: [FOUNDER],
    appointerNote: 'No D.1 row; Phase 1 catalog (Category D): FOUNDER appoints.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 1,
  }),
  entry({
    key: 'platform_developer',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHIEF_TECHNOLOGY_OFFICER],
    appointerNote: 'No D.1 row; Phase 1 catalog (Category D): CHIEF_TECHNOLOGY_OFFICER appoints.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'team_lead',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [NATIONAL_PROJECTS_DIRECTOR],
    appointerNote: 'No D.1 row; Phase 1 catalog (Category D): NATIONAL_PROJECTS_DIRECTOR appoints, one per unit.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'cubesat_team',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [NATIONAL_PROJECTS_DIRECTOR],
    appointerNote: 'Pool/unit membership (D.8 V3: absence is not a vacancy). Phase 1 catalog: NATIONAL_PROJECTS_DIRECTOR.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'rocketry_team',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [NATIONAL_PROJECTS_DIRECTOR],
    appointerNote: 'Pool/unit membership (D.8 V3). Phase 1 catalog: NATIONAL_PROJECTS_DIRECTOR.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'rover_team',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [NATIONAL_PROJECTS_DIRECTOR],
    appointerNote: 'Pool/unit membership (D.8 V3). Phase 1 catalog: NATIONAL_PROJECTS_DIRECTOR.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'member',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote:
      'Section D.1 row general_member: appointed by the Chapter President (admission). Phase 1 catalog (GENERAL_BODY) marks appointedBy NOT_APPLICABLE (divergence flagged).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'member_officer',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote:
      'Derived label (Art. 9.4), never appointed or stored directly; appointer recorded only so the map is total - the underlying office carries the real appointer. No direct remover.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
    removerRoleKeys: [],
  }),
  entry({
    key: 'member_advisor',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Section D.1 general-pool analog; Phase 1 catalog (GENERAL_BODY) marks NOT_APPLICABLE (divergence flagged).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'member_basic',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Section D.1 general-pool analog (admission); Phase 1 catalog (GENERAL_BODY) marks NOT_APPLICABLE (divergence flagged).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
];

/**
 * Section D vocabulary keys with no Phase 1 catalog key. These exist so
 * Section D's own consumers resolve: the Art. 7.2 chapter seats include
 * chapter_general_secretary and chapter_tech_lead (D.8 V2, and the adapter
 * layer's CHAPTER_OFFICER_SEATS), and the cadetship row (cadet) belongs to
 * Workstream F's pipeline. Keys here NEVER collide with APPOINTER_MAP keys
 * (asserted by test). The appointment guard consults this map only after
 * the catalog map, and integration may fold these into the catalog if the
 * catalog grows the keys.
 */
export const SECTION_D_SUPPLEMENTARY_APPOINTER_MAP: readonly AppointerMapEntry[] = [
  chapterOfficer({
    key: 'chapter_general_secretary',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Section D name for the catalog key chapter_secretary.',
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_tech_lead',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Art. 7.2 technical seat (D.8 V2). No Phase 1 catalog key.',
    defaultAppointer: false,
    probationRestorable: true,
    seatBound: true,
    holderCap: 1,
  }),
  chapterOfficer({
    key: 'chapter_coordinator',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    defaultAppointer: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  chapterOfficer({
    key: 'chapter_ambassador',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Appointer exception (D.1): s.7.3 makes the ambassador accountable to the Marketing Director, not appointed by him.',
    defaultAppointer: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  chapterOfficer({
    key: 'chapter_team_member',
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Appointed by the Chapter President, assisted by team leads (s.10.1 prose, D.1). Pool role: absence is not a vacancy (D.8 V3).',
    defaultAppointer: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'chapter_advisor',
    category: 'C',
    tier: 'none',
    chapterScoped: true,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Section D name for the catalog key faculty_advisor.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: true,
    holderCap: 1,
  }),
  entry({
    key: 'ambassador_seds',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [NATIONAL_MARKETING_DIRECTOR],
    appointerNote: 'Ambassador SEDS (D.1). Single named office but NOT derived as a vacancy in v1 (D.8).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'national_design_lead',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'National creative leads are members assigned by the Chapter President (Art. 10.2, D.1).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'national_web_lead',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Art. 10.2 (D.1).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'national_content_lead',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Art. 10.2 (D.1).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'national_social_media_lead',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Art. 10.2 (D.1).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'national_photography_lead',
    category: 'C',
    tier: 'nonOfficerPool',
    chapterScoped: false,
    appointingRoleKeys: [CHAPTER_PRESIDENT],
    appointerNote: 'Art. 10.2 (D.1).',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
  entry({
    key: 'cadet',
    category: 'C',
    tier: 'cadetship',
    chapterScoped: false,
    appointingRoleKeys: [NATIONAL_MEMBERSHIP_DIRECTOR],
    appointerNote: 'D.1: the National Membership Director appoints cadets. Cadetship pipeline is Workstream F.',
    defaultAppointer: false,
    minimumMembershipClassForFullPowers: null,
    ratificationRequired: false,
    probationRestorable: false,
    seatBound: false,
    holderCap: null,
  }),
];

const APPOINTER_BY_KEY: ReadonlyMap<string, AppointerMapEntry> = new Map(
  APPOINTER_MAP.map((e) => [e.key, e]),
);

const SUPPLEMENTARY_BY_KEY: ReadonlyMap<string, AppointerMapEntry> = new Map(
  SECTION_D_SUPPLEMENTARY_APPOINTER_MAP.map((e) => [e.key, e]),
);

/** Catalog map lookup. Undefined = not a catalog key (guard fails closed). */
export function getAppointerEntry(roleKey: string): AppointerMapEntry | undefined {
  return APPOINTER_BY_KEY.get(roleKey);
}

/** Catalog first, then the Section D supplementary vocabulary. */
export function getAppointerEntryIncludingSupplementary(
  roleKey: string,
): AppointerMapEntry | undefined {
  return APPOINTER_BY_KEY.get(roleKey) ?? SUPPLEMENTARY_BY_KEY.get(roleKey);
}

/** All role keys the catalog map covers, in catalog order. */
export const APPOINTER_MAP_KEYS: readonly string[] = APPOINTER_MAP.map((e) => e.key);
