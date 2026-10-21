/**
 * T2 (spec D.9): lifecycle guard units + T8 threshold math.
 */

import { FOUNDER_UID } from '@/lib/roles';
import type { LifecycleContext } from '@/types/lifecycle';
import {
  checkLifecycleGuards,
  requiredRefusals,
  shouldCreateRatificationRecord,
} from '../lifecycle-guard';
import { getAppointerEntry } from '../lifecycle-appointer-map';

function baseCtx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    targetUid: 'user-target',
    roleKey: 'chapter_treasurer',
    action: 'appoint',
    chapterSlug: 'ist',
    actorUid: 'user-actor',
    actorRoleKeys: ['chapter_president'],
    actorChapterSlug: 'ist',
    subjectMembershipClass: 'Provisional',
    subjectIsCadetInProbation: false,
    founderOverride: false,
    consentLookup: () => null,
    seatOccupancy: { holderUids: [], cap: 1 },
    ...overrides,
  };
}

describe('T2 guard: catalog completeness', () => {
  it('unknown role fails closed with ROLE_CATALOG_INCOMPLETE, even for the Founder', () => {
    const r = checkLifecycleGuards(
      baseCtx({ roleKey: 'no_such_role', actorUid: FOUNDER_UID, founderOverride: true }),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('ROLE_CATALOG_INCOMPLETE');
  });
});

describe('T2 guard: appointer match', () => {
  it('appointer mismatch is denied and names the expected appointer', () => {
    const r = checkLifecycleGuards(baseCtx({ actorRoleKeys: ['chapter_treasurer'] }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('APPOINTER_MISMATCH');
      expect(r.appointerKey).toBe('chapter_president');
      expect(r.detail).toContain('chapter_president');
    }
  });

  it('the catalog appointer is allowed', () => {
    const r = checkLifecycleGuards(baseCtx());
    expect(r).toEqual({
      allowed: true,
      appointerKey: 'chapter_president',
      viaFounderOverride: false,
    });
  });

  it('Board-appointer appointment without an offline_attested vote record is denied', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'governor_coopted',
        chapterSlug: undefined,
        actorRoleKeys: ['governor_founder'],
        actorChapterSlug: undefined,
        seatOccupancy: { holderUids: [], cap: 2 },
      }),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('BOARD_APPOINTER_EVIDENCE_MISSING');
  });

  it('Board-appointer appointment with valid vote evidence is allowed', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'governor_coopted',
        chapterSlug: undefined,
        actorRoleKeys: ['governor_founder'],
        actorChapterSlug: undefined,
        seatOccupancy: { holderUids: [], cap: 2 },
        boardAppointerVoteId: 'vote-1',
      }),
      { boardVoteEvidenceValid: true },
    );
    expect(r.allowed).toBe(true);
  });

  it('founder_appointer key held by a non-founder UID yields FOUNDER_OVERRIDE_ONLY', () => {
    const r = checkLifecycleGuards(
      baseCtx({ actorRoleKeys: ['founder_appointer'], actorUid: 'user-impostor' }),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('FOUNDER_OVERRIDE_ONLY');
  });
});

describe('T2 guard: chapter scope', () => {
  it('chapter president appointing outside own chapter is CROSS_CHAPTER_DENIED', () => {
    const r = checkLifecycleGuards(baseCtx({ chapterSlug: 'khi', actorChapterSlug: 'ist' }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('CROSS_CHAPTER_DENIED');
  });

  it('national president appointing a chapter president in any chapter is allowed', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'chapter_president',
        actorRoleKeys: ['president_national'],
        actorChapterSlug: undefined,
        chapterSlug: 'khi',
        subjectMembershipClass: 'Full',
      }),
    );
    expect(r.allowed).toBe(true);
  });

  it('chapter-scoped role without a chapterSlug is CHAPTER_MISMATCH', () => {
    const r = checkLifecycleGuards(baseCtx({ chapterSlug: undefined }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('CHAPTER_MISMATCH');
  });
});

describe('T2 guard: founder override and the hard fails', () => {
  it('founder override is allowed for an ordinary Category C mismatch and records the catalog appointer', () => {
    const r = checkLifecycleGuards(
      baseCtx({ actorUid: FOUNDER_UID, founderOverride: true, actorRoleKeys: [] }),
    );
    expect(r).toEqual({
      allowed: true,
      appointerKey: 'chapter_president',
      viaFounderOverride: true,
    });
  });

  it('founder override is allowed for an ordinary Category B mismatch (Full Member subject)', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'national_treasurer',
        chapterSlug: undefined,
        actorChapterSlug: undefined,
        actorUid: FOUNDER_UID,
        founderOverride: true,
        actorRoleKeys: [],
        subjectMembershipClass: 'Full',
      }),
    );
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.viaFounderOverride).toBe(true);
  });

  it('founder override does NOT bypass NOT_FULL_MEMBER', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'national_treasurer',
        chapterSlug: undefined,
        actorChapterSlug: undefined,
        actorUid: FOUNDER_UID,
        founderOverride: true,
        actorRoleKeys: [],
        subjectMembershipClass: 'Provisional',
      }),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('NOT_FULL_MEMBER');
  });

  it('founder override does NOT bypass CADET_IN_PROBATION', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        actorUid: FOUNDER_UID,
        founderOverride: true,
        actorRoleKeys: [],
        subjectIsCadetInProbation: true,
      }),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('CADET_IN_PROBATION');
  });

  it('a decided schedule_3_2_c Consent admits a non-Full Category B appointee', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'national_treasurer',
        chapterSlug: undefined,
        actorChapterSlug: undefined,
        actorUid: FOUNDER_UID,
        founderOverride: true,
        actorRoleKeys: [],
        subjectMembershipClass: 'Provisional',
        consentLookup: () => ({ id: 'consent-1', subjectUid: 'user-target', roleKey: 'national_treasurer', status: 'decided' }),
      }),
    );
    expect(r.allowed).toBe(true);
  });

  it('day-30 vacancy fallback lets the Founder appoint notwithstanding the catalog appointer, but not past a hard fail', () => {
    const ok = checkLifecycleGuards(
      baseCtx({ actorUid: FOUNDER_UID, founderOverride: false, actorRoleKeys: [] }),
      { vacancyFallbackAvailable: true },
    );
    expect(ok.allowed).toBe(true);
    const blocked = checkLifecycleGuards(
      baseCtx({
        actorUid: FOUNDER_UID,
        founderOverride: false,
        actorRoleKeys: [],
        subjectIsCadetInProbation: true,
      }),
      { vacancyFallbackAvailable: true },
    );
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.code).toBe('CADET_IN_PROBATION');
  });
});

describe('T2 guard: seat occupancy', () => {
  it('a full seat denies a non-holder with SEAT_OCCUPIED; a current holder passes', () => {
    const denied = checkLifecycleGuards(
      baseCtx({ seatOccupancy: { holderUids: ['someone-else'], cap: 1 } }),
    );
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.code).toBe('SEAT_OCCUPIED');
    const ok = checkLifecycleGuards(
      baseCtx({ seatOccupancy: { holderUids: ['user-target'], cap: 1 } }),
    );
    expect(ok.allowed).toBe(true);
  });

  it('pool roles are never seat-blocked', () => {
    const r = checkLifecycleGuards(
      baseCtx({
        roleKey: 'cubesat_team',
        chapterSlug: undefined,
        actorChapterSlug: undefined,
        actorRoleKeys: ['national_projects_director'],
        seatOccupancy: { holderUids: ['a', 'b', 'c'], cap: null },
      }),
    );
    expect(r.allowed).toBe(true);
  });
});

describe('T8 threshold math: requiredRefusals = ceil(2/3 * frozen electorate)', () => {
  it.each([
    [9, 6],
    [7, 5],
    [5, 4],
    [3, 2],
    [1, 1],
    [2, 2],
    [6, 4],
  ])('electors %i -> required %i', (electors, required) => {
    expect(requiredRefusals(electors)).toBe(required);
  });
});

describe('D.4 ratification creation condition', () => {
  it('founder-appointed Category B creates a record; Board-appointed and Category C do not', () => {
    const catB = getAppointerEntry('national_treasurer');
    expect(
      shouldCreateRatificationRecord({ entry: catB, appointedByUid: FOUNDER_UID, viaBoardVote: false }),
    ).toBe(true);
    expect(
      shouldCreateRatificationRecord({ entry: catB, appointedByUid: FOUNDER_UID, viaBoardVote: true }),
    ).toBe(false);
    expect(
      shouldCreateRatificationRecord({ entry: catB, appointedByUid: 'someone-else', viaBoardVote: false }),
    ).toBe(true); // entry appointer IS founder_appointer; appointer path decides
    const catC = getAppointerEntry('chapter_treasurer');
    expect(
      shouldCreateRatificationRecord({ entry: catC, appointedByUid: FOUNDER_UID, viaBoardVote: false }),
    ).toBe(false);
    const ed = getAppointerEntry('executive_director');
    expect(
      shouldCreateRatificationRecord({ entry: ed, appointedByUid: 'governor-1', viaBoardVote: true }),
    ).toBe(false);
  });
});
