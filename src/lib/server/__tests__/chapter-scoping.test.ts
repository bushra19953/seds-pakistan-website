/**
 * Tests for applyChapterScope scope resolution.
 *
 * Regression: the founder's users/{uid}.role is the legacy token 'admin',
 * which is absent from DEFAULT_ROLE_SCOPES. The old fallback treated every
 * unlisted token as chapter scope, so the admin dashboard counted only
 * users docs carrying the founder's chapterId (129) instead of the whole
 * users collection (188). The canonical taxonomy in src/lib/roles.ts maps
 * 'admin' to superadmin with national scope; applyChapterScope must honor
 * it for tokens the baseline table does not list.
 *
 * getDb() is mocked to null, so the dynamic permissions/{role}._scope
 * override is skipped and these tests pin the static resolution only.
 */

jest.mock('@/lib/server/firebase-admin', () => ({
    getDb: () => null,
    admin: {},
}));

import { applyChapterScope } from '../chapter-scoping';

function fakeQuery() {
    const calls: Array<[string, string, unknown]> = [];
    const q: any = {
        calls,
        where(field: string, op: string, value: unknown) {
            calls.push([field, op, value]);
            return q;
        },
    };
    return q;
}

describe('applyChapterScope', () => {
    it('returns the query unscoped for superadmin (baseline global)', async () => {
        const q = fakeQuery();
        const out = await applyChapterScope(q, { role: 'superadmin', chapterId: 'seds-ist-chapter' });
        expect(out).toBe(q);
        expect(q.calls).toHaveLength(0);
    });

    it('returns the query unscoped for president_national (baseline global)', async () => {
        const q = fakeQuery();
        const out = await applyChapterScope(q, { role: 'president_national', chapterId: 'seds-ist-chapter' });
        expect(out).toBe(q);
        expect(q.calls).toHaveLength(0);
    });

    it("treats legacy token 'admin' as global (canonical superadmin, national scope)", async () => {
        const q = fakeQuery();
        const out = await applyChapterScope(q, { role: 'admin', chapterId: 'seds-ist-chapter' });
        expect(out).toBe(q);
        expect(q.calls).toHaveLength(0);
    });

    it("treats legacy token 'president' as global (canonical president_national)", async () => {
        const q = fakeQuery();
        const out = await applyChapterScope(q, { role: 'president', chapterId: 'seds-ist-chapter' });
        expect(out).toBe(q);
        expect(q.calls).toHaveLength(0);
    });

    it('scopes members to their own chapter', async () => {
        const q = fakeQuery();
        await applyChapterScope(q, { role: 'member', chapterId: 'seds-ist-chapter' });
        expect(q.calls).toEqual([['chapterId', '==', 'seds-ist-chapter']]);
    });

    it('scopes canonical chapter roles to their own chapter', async () => {
        const q = fakeQuery();
        await applyChapterScope(q, { role: 'chair_design', chapterId: 'seds-ist-chapter' });
        expect(q.calls).toEqual([['chapterId', '==', 'seds-ist-chapter']]);
    });

    it('blocks all data for a chapter-scoped user with no chapterId', async () => {
        const q = fakeQuery();
        await applyChapterScope(q, { role: 'member' });
        expect(q.calls).toEqual([['chapterId', '==', 'RESTRICTED_NO_CHAPTER']]);
    });
});
