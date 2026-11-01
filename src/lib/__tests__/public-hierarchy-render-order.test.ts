/**
 * Render-order tests for the hierarchy fix (lead bylaws rank spec,
 * 2026-11-01, QUEUE.md P2 spec), on pure fixtures (zero live reads).
 *
 * F1 cases live here: catalog additionalRoles seats materialize as
 * entries, and a section's root is its lowest-level PRESENT entry
 * per the spec — never members[0] by position. The co-held-parent
 * deputy case lands with F4 (it needs the F4 edge rule); the full
 * spec-order assertions (bands, XP order) land with F2.
 */
import {
  buildPublicHierarchy,
  rootMemberIndex,
} from '../public-hierarchy';
import type { RawHierarchyUser } from '../public-hierarchy';

const FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
const IST = 'seds-ist-chapter';

function user(partial: Partial<RawHierarchyUser> & { id: string }): RawHierarchyUser {
  return { displayName: 'Person', role: 'member_basic', ...partial };
}

function build(
  users: RawHierarchyUser[],
  defs = new Map<string, Record<string, unknown>>(),
  grants = new Map<string, unknown>()
) {
  return buildPublicHierarchy({
    users,
    chapters: [{ id: IST, name: 'IST Chapter' }],
    roleDefinitions: defs,
    additionalRolesByUid: grants,
  });
}

describe('hierarchy render order (F1)', () => {
  it('IST case: a chapter_president held only via additionalRoles is the section root, and the finance chair is not', () => {
    const grants = new Map<string, unknown>([
      [FOUNDER_UID, ['chapter_president']],
    ]);
    const payload = build(
      [
        // The Founder's president seat lives ONLY in additionalRoles;
        // the stored role is the member floor (the live defect).
        user({ id: FOUNDER_UID, displayName: 'The Founder', role: 'member_basic', chapterId: IST }),
        user({ id: 'u-finance', displayName: 'Finance Chair', role: 'chapter_finance_chair', chapterId: IST }),
        user({ id: 'u-treasurer', displayName: 'Treasurer', role: 'chapter_treasurer', chapterId: IST }),
        user({ id: 'u-recruit', displayName: 'Recruitment Chair', role: 'chapter_recruitment_chair', chapterId: IST }),
      ],
      new Map(),
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist).toBeDefined();
    const president = ist!.members.find((m) => m.roleTitle === 'Chapter President');
    expect(president).toBeDefined();
    expect(president!.isCustomRole).toBe(false);
    expect(president!.level).toBe(3);
    const finance = ist!.members.find((m) => m.roleTitle === 'Chapter Finance Chair');
    expect(finance!.level).toBe(4);
    // The root rule: lowest-level present entry wins, whatever its
    // position in the feed — the president, not members[0] by luck.
    const root = ist!.members[rootMemberIndex(ist!.members)];
    expect(root.roleTitle).toBe('Chapter President');
    expect(root).not.toBe(finance);
  });

  it('materializes a president_national grant into the National section', () => {
    const grants = new Map<string, unknown>([['u-nat', ['president_national']]]);
    const payload = build(
      [user({ id: 'u-nat', displayName: 'Nat Prez', role: 'member_basic' })],
      new Map(),
      grants
    );
    const national = payload.sections.find((s) => s.id === 'national');
    expect(national?.members).toHaveLength(1);
    expect(national!.members[0].roleTitle).toBe('National President');
    expect(national!.members[0].isCustomRole).toBe(false);
    expect(national!.members[0].level).toBe(2);
  });

  it('dedupes a catalog grant that repeats the base holding, by slug and by title', () => {
    const grants = new Map<string, unknown>([
      ['u-same-slug', ['chapter_treasurer']],
      // Legacy alias for the same office: same resolved title.
      ['u-same-title', ['treasurer']],
    ]);
    const payload = build(
      [
        user({ id: 'u-same-slug', displayName: 'Same Slug', role: 'chapter_treasurer', chapterId: IST }),
        user({ id: 'u-same-title', displayName: 'Same Title', role: 'chapter_treasurer', chapterId: IST }),
      ],
      new Map(),
      grants
    );
    const ist = payload.sections.find((s) => s.id === IST);
    expect(ist?.members).toHaveLength(2);
    expect(ist!.members.every((m) => m.roleTitle === 'Chapter Treasurer')).toBe(true);
  });

  it('never merges a plain-member catalog grant, and never lists a plain-member base (F3 safety half of the merge)', () => {
    const grants = new Map<string, unknown>([
      ['u-grant-member', ['member', 'member_advisor']],
    ]);
    const payload = build(
      [
        user({ id: 'u-grant-member', displayName: 'Grant Member', role: 'member_basic', chapterId: IST }),
        user({ id: 'u-plain-member', displayName: 'Plain Member', role: 'member', chapterId: IST }),
        user({ id: 'u-plain-advisor', displayName: 'Plain Advisor', role: 'member_advisor', chapterId: IST }),
      ],
      new Map(),
      grants
    );
    expect(payload.sections).toEqual([]);
  });

  it('rootMemberIndex: empty is -1, ties keep feed order, lowest level wins from any position', () => {
    expect(rootMemberIndex([])).toBe(-1);
    expect(rootMemberIndex([{ level: 4 }, { level: 4 }])).toBe(0);
    expect(
      rootMemberIndex([{ level: 4 }, { level: 3 }, { level: 4 }])
    ).toBe(1);
    expect(
      rootMemberIndex([{ level: 6 }, { level: 5 }, { level: 4 }])
    ).toBe(2);
  });
});
