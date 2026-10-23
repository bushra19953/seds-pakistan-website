/**
 * Shared fixture for the Custom Roles consumers Surface 4 tests
 * (hierarchy title consistency, plan section 6.4): ONE fixture person,
 * ONE definition, asserted identically by the clusters suite, the
 * canvas suite and the user-node suite, so pill text == node text ==
 * detail panel text is established character for character against the
 * same constant.
 *
 * The definition name ('Poster Squad Lead') deliberately differs from
 * the humanised slug ('Poster Team Lead'): any surface still rendering
 * a fallback instead of the definition title fails these tests.
 */
import type { CustomRoleDefinition } from '@/lib/custom-roles';

export const CUSTOM_ROLE_SLUG = 'custom_poster_team_lead';
export const CUSTOM_ROLE_NAME = 'Poster Squad Lead';
export const CUSTOM_MARKER_TEXT = 'Custom';

export const POSTER_DEF: CustomRoleDefinition = {
  slug: CUSTOM_ROLE_SLUG,
  name: CUSTOM_ROLE_NAME,
  description: 'Runs the poster squad for the chapter.',
  parentRoleKey: 'chapter_design_chair',
  chapterId: 'seds-ist-chapter',
  permissions: [],
  isActive: true,
  defaultTermDays: null,
};

/** The fixture person: stored PRIMARY role is the custom slug (the
 *  plan C-1 case: hierarchy titles the primary stored role). */
export const CUSTOM_USER = {
  id: 'u-custom',
  displayName: 'Custom Person',
  email: 'custom@example.com',
  role: CUSTOM_ROLE_SLUG,
  chapterId: 'seds-ist-chapter',
};

/** A catalog holder: renders exactly as before the program. */
export const CATALOG_USER = {
  id: 'u-prez',
  displayName: 'Prez Person',
  email: 'prez@example.com',
  role: 'president_national',
  chapterId: null as string | null,
};

/** A genuinely unknown, non-custom token: every surface keeps today's
 *  divergent fallback rendering for it (SEC-10 lock). */
export const UNKNOWN_USER = {
  id: 'u-unknown',
  displayName: 'Unknown Person',
  email: 'unknown@example.com',
  role: 'team_member',
  chapterId: 'seds-ist-chapter',
};
