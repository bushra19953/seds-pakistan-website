/**
 * MSG40 — Chart-seat proof, on the REAL projection.
 *
 * The brief requires proof in a test, not by assertion: after a grant
 * removal, the member must disappear from that seat on the public
 * hierarchy payload. This exercises buildPublicHierarchy itself with
 * the same additionalRolesByUid input the public route builds from
 * roles/{uid}.additionalRoles, before and after the removal.
 *
 * - A plain-member deputy holds ONLY the grant seat, so removing the
 *   grant removes the person from the chart entirely.
 * - An officer holding a deputy grant keeps the base seat and loses
 *   only the deputy seat.
 * - Removing one of two grants leaves the other seat standing.
 */
import { buildPublicHierarchy } from '../public-hierarchy';
import type { RawHierarchyUser } from '../public-hierarchy';

const IST = 'seds-ist-chapter';
const DEPUTY_A = 'custom_chapter_vp_deputy_technical_systems';
const DEPUTY_B = 'custom_chapter_vp_deputy_outreach';

const DEF_A = {
  isCustom: true,
  slug: DEPUTY_A,
  name: 'Chapter VP Deputy - Technical Systems',
  description: 'Deputy to the Chapter VP for technical systems.',
  parentRoleKey: 'chapter_vice_president',
  chapterId: IST,
  permissions: [],
  isActive: true,
  defaultTermDays: null,
};

const DEF_B = {
  isCustom: true,
  slug: DEPUTY_B,
  name: 'Chapter VP Deputy - Outreach',
  description: 'Deputy to the Chapter VP for outreach.',
  parentRoleKey: 'chapter_vice_president',
  chapterId: IST,
  permissions: [],
  isActive: true,
  defaultTermDays: null,
};

function user(partial: Partial<RawHierarchyUser> & { id: string }): RawHierarchyUser {
  return { displayName: 'Person', role: 'member_basic', ...partial };
}

function build(users: RawHierarchyUser[], grants: Map<string, unknown>) {
  return buildPublicHierarchy({
    users,
    chapters: [{ id: IST, name: 'IST Chapter' }],
    roleDefinitions: new Map<string, Record<string, unknown>>([
      [DEPUTY_A, DEF_A as unknown as Record<string, unknown>],
      [DEPUTY_B, DEF_B as unknown as Record<string, unknown>],
    ]),
    additionalRolesByUid: grants,
  });
}

function seatsFor(payload: ReturnType<typeof buildPublicHierarchy>, uid: string) {
  return payload.sections.flatMap((s) => s.members).filter((m) => m.id === uid);
}

describe('MSG40 chart-seat proof (buildPublicHierarchy, real projection)', () => {
  it('a plain-member deputy vanishes from the chart when the grant is removed', () => {
    const deputy = user({ id: 'u-deputy', displayName: 'Deputy Dana', chapterId: IST });
    const before = build([deputy], new Map([['u-deputy', [DEPUTY_A]]]));
    const beforeSeats = seatsFor(before, 'u-deputy');
    expect(beforeSeats).toHaveLength(1);
    expect(beforeSeats[0].roleTitle).toBe('Chapter VP Deputy - Technical Systems');
    expect(beforeSeats[0].level).toBe(5);
    expect(beforeSeats[0].isCustomRole).toBe(true);

    const after = build([deputy], new Map([['u-deputy', []]]));
    expect(seatsFor(after, 'u-deputy')).toHaveLength(0);
  });

  it('an officer keeps the base seat and loses only the deputy seat', () => {
    const officer = user({
      id: 'u-officer',
      displayName: 'Officer Omar',
      role: 'chapter_secretary',
      chapterId: IST,
    });
    const before = build([officer], new Map([['u-officer', [DEPUTY_A]]]));
    expect(seatsFor(before, 'u-officer').map((m) => m.roleTitle).sort()).toEqual(
      ['Chapter Secretary', 'Chapter VP Deputy - Technical Systems'].sort(),
    );

    const after = build([officer], new Map([['u-officer', []]]));
    const afterSeats = seatsFor(after, 'u-officer');
    expect(afterSeats).toHaveLength(1);
    expect(afterSeats[0].roleTitle).toBe('Chapter Secretary');
  });

  it('removing one of two grants leaves the other seat standing', () => {
    const deputy = user({ id: 'u-deputy', displayName: 'Deputy Dana', chapterId: IST });
    const before = build([deputy], new Map([['u-deputy', [DEPUTY_A, DEPUTY_B]]]));
    expect(seatsFor(before, 'u-deputy')).toHaveLength(2);

    const after = build([deputy], new Map([['u-deputy', [DEPUTY_B]]]));
    const afterSeats = seatsFor(after, 'u-deputy');
    expect(afterSeats).toHaveLength(1);
    expect(afterSeats[0].roleTitle).toBe('Chapter VP Deputy - Outreach');
  });
});
