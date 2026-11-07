/**
 * resolveAssigneeDisplayRoles: the KEYED display-role resolution for
 * GET /api/workflows detail (MSG47 follow-up, 2026-11-07 incident).
 *
 * The route handler derives its assignee id list from the
 * sequenceIndex-SORTED tasks, while the Supa seam builds its roles
 * snap list parallel to its own RAW-fetch id order. The handler once
 * paired the two lists by INDEX, so when the orders differed the
 * first handler uid received the first seam snap's grants: in the
 * role-grant workflow the seam order was [Emaan, Ahmed] against the
 * handler's [Ahmed, Emaan], and Ahmed's mission-PDF personnel row
 * printed Emaan's "Marketing Deputy - Social Media (custom)" label.
 *
 * These tests pin the keyed contract: a snap resolves ONLY against
 * the uid in its own `id`, whatever position it arrives in.
 */

import { resolveAssigneeDisplayRoles } from '@/lib/custom-roles';

const NOW = new Date('2026-11-07T00:00:00.000Z');

const AHMED = 'uid-ahmed';
const EMAAN = 'uid-emaan';
const CUSTOM_SOCIAL = 'custom_marketing_deputy_social_media';

// The incident's real role-doc shapes (2026-11-07 role-grant workflow).
const AHMED_ROLE_DOC = { role: 'chapter_vice_president', additionalRoles: [] as string[] };
const EMAAN_ROLE_DOC = {
  role: 'chapter_recruitment_chair',
  additionalRoles: [CUSTOM_SOCIAL],
};

const PRIMARY_BY_UID: Record<string, string | null> = {
  [AHMED]: 'chapter_vice_president',
  [EMAAN]: 'chapter_recruitment_chair',
};

function snap(id: string, doc: Record<string, unknown> | undefined) {
  return { id, exists: doc !== undefined, data: () => doc };
}

const ahmedSnap = () => snap(AHMED, AHMED_ROLE_DOC);
const emaanSnap = () => snap(EMAAN, EMAAN_ROLE_DOC);

describe('resolveAssigneeDisplayRoles (keyed by snap id)', () => {
  it('REVERSED snap order (the incident): the grant lands only on its holder', () => {
    // Handler order from the sorted tasks: [Ahmed, Emaan].
    // Seam snap order from the raw fetch: [Emaan, Ahmed].
    const result = resolveAssigneeDisplayRoles(
      [AHMED, EMAAN],
      [emaanSnap(), ahmedSnap()],
      PRIMARY_BY_UID,
      NOW,
    );
    expect(result).toEqual({ [EMAAN]: CUSTOM_SOCIAL });
    expect(result).not.toHaveProperty(AHMED);
  });

  it('same-order snaps: behavior unchanged', () => {
    const result = resolveAssigneeDisplayRoles(
      [AHMED, EMAAN],
      [ahmedSnap(), emaanSnap()],
      PRIMARY_BY_UID,
      NOW,
    );
    expect(result).toEqual({ [EMAAN]: CUSTOM_SOCIAL });
    expect(result).not.toHaveProperty(AHMED);
  });

  it('a snap whose id is missing is skipped, never positionally assigned', () => {
    // A grant-carrying snap with NO id sits in Ahmed's old positional
    // slot; keyed resolution must not let it touch anyone.
    const idLessGrantSnap = { exists: true, data: () => EMAAN_ROLE_DOC };
    const result = resolveAssigneeDisplayRoles(
      [AHMED, EMAAN],
      [idLessGrantSnap, ahmedSnap()],
      PRIMARY_BY_UID,
      NOW,
    );
    expect(result).toEqual({});
  });

  it('a snap for a uid outside the assignee list is ignored', () => {
    const result = resolveAssigneeDisplayRoles(
      [AHMED],
      [emaanSnap(), ahmedSnap()],
      PRIMARY_BY_UID,
      NOW,
    );
    expect(result).toEqual({});
  });

  it('missing roles doc (exists: false) and null snaps yield no display role', () => {
    const result = resolveAssigneeDisplayRoles(
      [AHMED, EMAAN],
      [snap(EMAAN, undefined), null],
      PRIMARY_BY_UID,
      NOW,
    );
    expect(result).toEqual({});
  });

  it('several held grants: the first in stored order wins', () => {
    const multiSnap = snap(EMAAN, {
      role: 'chapter_recruitment_chair',
      additionalRoles: ['custom_events_deputy_staging_field_logistics', CUSTOM_SOCIAL],
    });
    const result = resolveAssigneeDisplayRoles(
      [EMAAN],
      [multiSnap],
      PRIMARY_BY_UID,
      NOW,
    );
    expect(result).toEqual({
      [EMAAN]: 'custom_events_deputy_staging_field_logistics',
    });
  });
});
