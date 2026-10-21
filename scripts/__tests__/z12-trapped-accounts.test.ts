/**
 * @jest-environment node
 *
 * Z-12 trapped-accounts generator tests (spec E.9 step 3). The
 * analysis runs against FIXTURES only - never production data.
 */
import { analyzeTrappedAccounts } from '../z12-trapped-accounts';

const NOW = new Date('2026-10-21T00:00:00.000Z');

describe('analyzeTrappedAccounts', () => {
    test('classifies every trapped-account class and leaves clean accounts out', () => {
        const report = analyzeTrappedAccounts(
            {
                users: [
                    // Clean: board-expelled member, counts agree.
                    { uid: 'clean-1', isBanned: true, bannedBy: 'board:v1', warningCount: 1 },
                    // (a) legacy threshold ban
                    { uid: 'a-1', isBanned: true, bannedBy: null, banReason: 'Exceeded 3 warnings. Auto-blacklisted.', warningCount: 3 },
                    // (b) issue-warning threshold blacklist
                    { uid: 'b-1', isBlacklisted: true, blacklistReason: 'Reached 3 active warnings.', warningCount: 3 },
                    // (c) drift
                    { uid: 'c-1', warningCount: 5 },
                    // (d) probation suspect
                    { uid: 'd-1', isOnProbation: true, warningCount: 0, role: 'team_member' },
                ],
                warningsByUid: {
                    'clean-1': [{ id: 'w1' }],
                    'a-1': [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
                    'b-1': [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
                    'c-1': [{ id: 'w1' }],
                    'd-1': [],
                },
            },
            'fixture',
            NOW,
        );
        expect(report.totals.usersScanned).toBe(5);
        const byUid = new Map(report.findings.map((f) => [f.uid, f]));
        expect(byUid.has('clean-1')).toBe(false);
        expect(byUid.get('a-1')?.classes).toContain('banned_without_board_vote');
        expect(byUid.get('b-1')?.classes).toContain('blacklisted_via_setting_path');
        expect(byUid.get('b-1')?.details.blacklistPath).toBe('issue_warning_threshold');
        expect(byUid.get('a-1')?.details.banReason).toContain('Auto-blacklisted');
        expect(byUid.get('c-1')?.classes).toContain('warning_count_drift');
        expect(byUid.get('c-1')?.details).toMatchObject({ storedWarningCount: 5, warningDocuments: 1 });
        expect(byUid.get('d-1')?.classes).toContain('probation_demotion_suspect');
        expect(report.totals.byClass.banned_without_board_vote).toBe(1);
        expect(report.source).toBe('fixture');
    });

    test('(e) public mirror mismatch is reported when a mirror is provided', () => {
        const report = analyzeTrappedAccounts(
            {
                users: [{ uid: 'e-1', warningCount: 2, isBanned: false }],
                warningsByUid: { 'e-1': [{ id: 'w1' }, { id: 'w2' }] },
                publicMirrorByUid: { 'e-1': { warningCount: 0, isBanned: true } },
            },
            'fixture',
            NOW,
        );
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].classes).toContain('public_mirror_mismatch');
        expect(report.findings[0].details.mismatchedFields).toEqual(
            expect.arrayContaining(['warningCount', 'isBanned']),
        );
    });
});
