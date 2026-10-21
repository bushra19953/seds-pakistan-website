/**
 * Tests for resolveEffectiveScope / resolveChapterFilter (Item 5,
 * spec 5(f)): the dynamic permissions/{role}._scope override, the
 * static fallbacks, and the R1-R3 chapter filter rule shared by
 * /api/admin/dashboard/init and /api/admin/users.
 */

const state = {
  permissionDocs: new Map<string, Record<string, unknown>>(),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({
    collection: (_name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = state.permissionDocs.get(id);
          return { exists: !!data, data: () => data };
        },
      }),
    }),
  }),
  admin: {},
}));

import {
  resolveEffectiveScope,
  resolveChapterFilter,
  RESTRICTED_NO_CHAPTER,
} from '../chapter-scoping';

beforeEach(() => {
  state.permissionDocs = new Map();
});

describe('resolveEffectiveScope (Item 5)', () => {
  it('honours the dynamic _scope override when a permissions doc exists', async () => {
    state.permissionDocs.set('member', { _scope: 'global' });
    await expect(resolveEffectiveScope('member')).resolves.toBe('global');

    state.permissionDocs.set('superadmin', { _scope: 'chapter' });
    await expect(resolveEffectiveScope('superadmin')).resolves.toBe('chapter');
  });

  it('falls back to DEFAULT_ROLE_SCOPES when no override doc exists', async () => {
    await expect(resolveEffectiveScope('superadmin')).resolves.toBe('global');
    await expect(resolveEffectiveScope('president_national')).resolves.toBe('global');
    await expect(resolveEffectiveScope('chair_design')).resolves.toBe('chapter');
  });

  it('falls back through resolveUserScope for unknown tokens (legacy admin is global, member is chapter)', async () => {
    await expect(resolveEffectiveScope('admin')).resolves.toBe('global');
    await expect(resolveEffectiveScope('totally-unknown-token')).resolves.toBe('chapter');
  });
});

describe('resolveChapterFilter R1-R3 (Item 5)', () => {
  it('R1: global caller, no request, gets no filter', () => {
    expect(
      resolveChapterFilter({ scope: 'global', callerChapterId: 'ist', requestedChapterId: null })
    ).toEqual({ ok: true, scope: 'global', effectiveChapterId: null });
  });

  it('R1: global caller with a request filters to the requested chapter', () => {
    expect(
      resolveChapterFilter({ scope: 'global', callerChapterId: null, requestedChapterId: 'seds-ist-chapter' })
    ).toEqual({ ok: true, scope: 'global', effectiveChapterId: 'seds-ist-chapter' });
  });

  it("R1/R2: 'All' is the client's unfiltered spelling for both scopes", () => {
    expect(
      resolveChapterFilter({ scope: 'global', callerChapterId: null, requestedChapterId: 'All' })
    ).toEqual({ ok: true, scope: 'global', effectiveChapterId: null });
    expect(
      resolveChapterFilter({ scope: 'chapter', callerChapterId: 'ist', requestedChapterId: 'All' })
    ).toEqual({ ok: true, scope: 'chapter', effectiveChapterId: 'ist' });
  });

  it('R2: chapter caller with no request or their own chapter resolves to their own chapter', () => {
    expect(
      resolveChapterFilter({ scope: 'chapter', callerChapterId: 'ist', requestedChapterId: null })
    ).toEqual({ ok: true, scope: 'chapter', effectiveChapterId: 'ist' });
    expect(
      resolveChapterFilter({ scope: 'chapter', callerChapterId: 'ist', requestedChapterId: 'ist' })
    ).toEqual({ ok: true, scope: 'chapter', effectiveChapterId: 'ist' });
  });

  it('R2: chapter caller asking for a foreign chapter is rejected, never substituted', () => {
    expect(
      resolveChapterFilter({ scope: 'chapter', callerChapterId: 'ist', requestedChapterId: 'other' })
    ).toEqual({ ok: false, reason: 'foreign-chapter' });
  });

  it('R3: chapter caller with no own chapterId gets the match-nothing sentinel', () => {
    expect(
      resolveChapterFilter({ scope: 'chapter', callerChapterId: null, requestedChapterId: null })
    ).toEqual({ ok: true, scope: 'chapter', effectiveChapterId: RESTRICTED_NO_CHAPTER });
  });
});
