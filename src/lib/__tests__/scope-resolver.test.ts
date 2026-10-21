/**
 * Phase 1 Workstream C - the single scope resolver (spec C.6).
 * Includes the mandatory regression case for the Oct 20 PERSONNEL bug:
 * the founder (stored role 'admin', chapterId = seds-ist-chapter) must
 * resolve GLOBAL through the UID check, never chapter-scoped.
 */
import {
  resolveScope,
  canAccessChapter,
  scopeAllowsAnyChapter,
  RESTRICTED_NO_CHAPTER,
} from '../scope';
import { FOUNDER_UID } from '@/config/founder';

const IST = 'seds-ist-chapter';

describe('scope-resolver', () => {
  it('FOUNDER REGRESSION: founder with legacy admin token and an IST chapterId resolves global', () => {
    const scope = resolveScope({ uid: FOUNDER_UID, role: 'admin', chapterId: IST });
    expect(scope.level).toBe('global');
    expect(scope.source).toBe('founder');
    expect(scopeAllowsAnyChapter(scope)).toBe(true);
    expect(canAccessChapter(scope, 'any-other-chapter')).toBe(true);
  });

  it('the admin token on a non-founder uid grants nothing (restricted)', () => {
    const scope = resolveScope({ uid: 'someone-else', role: 'admin', chapterId: IST });
    expect(scope.level).toBe('restricted');
    expect(scope.source).toBe('unresolved-role');
  });

  it('superadmin resolves through the catalog to the CTO (national)', () => {
    const scope = resolveScope({ uid: 'cto-uid', role: 'superadmin', chapterId: IST });
    expect(scope.roleKey).toBe('chief_technology_officer');
    expect(scope.level).toBe('national');
  });

  it('R4 governors are global; R3 national officers are national', () => {
    expect(resolveScope({ uid: 'g', role: 'governor_member', chapterId: null }).level).toBe('global');
    expect(resolveScope({ uid: 'p', role: 'president_national', chapterId: IST }).level).toBe('national');
    expect(resolveScope({ uid: 't', role: 'national_treasurer', chapterId: null }).level).toBe('national');
  });

  it('legacy tokens resolve through the corrected map (treasurer is chapter-scoped)', () => {
    const scope = resolveScope({ uid: 'x', role: 'treasurer', chapterId: IST });
    expect(scope.roleKey).toBe('chapter_treasurer');
    expect(scope.level).toBe('chapter');
    expect(scope.chapterId).toBe(IST);
  });

  it('a chapter officer without a chapterId is restricted to the sentinel (fail-closed)', () => {
    const scope = resolveScope({ uid: 'cp', role: 'chapter_president', chapterId: null });
    expect(scope.level).toBe('restricted');
    expect(scope.chapterId).toBe(RESTRICTED_NO_CHAPTER);
    expect(scope.source).toBe('missing-chapter');
    expect(canAccessChapter(scope, IST)).toBe(false);
  });

  it('an invented token with a chapterId is NOT widened by the chapterId (no fallback promotion)', () => {
    const scope = resolveScope({ uid: 'inv', role: 'national_vp_operations', chapterId: IST });
    expect(scope.level).toBe('restricted');
    expect(scope.roleKey).toBeNull();
    // Restricted visibility covers only the caller's own chapter records.
    expect(canAccessChapter(scope, IST)).toBe(true);
    expect(canAccessChapter(scope, 'other-chapter')).toBe(false);
  });

  it('a plain member is restricted to their own chapter; without one, the sentinel', () => {
    expect(resolveScope({ uid: 'm', role: 'member', chapterId: IST }).level).toBe('restricted');
    const noChapter = resolveScope({ uid: 'm2', role: 'member', chapterId: null });
    expect(noChapter.chapterId).toBe(RESTRICTED_NO_CHAPTER);
    expect(canAccessChapter(noChapter, IST)).toBe(false);
  });

  it('null and empty roles are restricted, never global', () => {
    for (const role of [null, '']) {
      const scope = resolveScope({ uid: 'n', role, chapterId: IST });
      expect(scope.level).toBe('restricted');
      expect(scopeAllowsAnyChapter(scope)).toBe(false);
    }
  });

  it('canAccessChapter: global and national reach every chapter', () => {
    const national = resolveScope({ uid: 'p', role: 'president_national', chapterId: null });
    expect(canAccessChapter(national, IST)).toBe(true);
    expect(canAccessChapter(national, null)).toBe(true);
    const chapter = resolveScope({ uid: 'c', role: 'chapter_president', chapterId: IST });
    expect(canAccessChapter(chapter, IST)).toBe(true);
    expect(canAccessChapter(chapter, 'other')).toBe(false);
  });
});
