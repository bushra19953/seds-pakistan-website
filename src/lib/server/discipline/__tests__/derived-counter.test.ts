/**
 * @jest-environment node
 *
 * Spec E.11 derived counter tests: T39, T40. Plus the expulsion Cause
 * validation suite T27 (applyExpulsionBan lives in apply-decision.ts).
 */
jest.mock('@/lib/server/firebase-admin', () => ({
    getDb: () => null,
    ensureAdminInitialized: () => false,
    admin: {},
    adminDb: null,
    getAdminStorage: () => null,
    getLastAdminError: () => null,
    getAdminDiagnostics: () => ({}),
}));
jest.mock('@/lib/server/notification-service', () => ({
    notificationService: { send: jest.fn(async () => undefined) },
}));

import { makeFakeDb } from './fake-firestore';
import { computeDerivedWarningCount, reconcileWarningCounts } from '../derived-counter';
import { applyExpulsionBan } from '../apply-decision';

const NOW = new Date('2026-10-21T12:00:00.000Z');

function strikeCase(db: any, id: string, overrides: Record<string, any> = {}) {
    db.seed(`disciplinary_cases/${id}`, {
        caseId: id,
        caseNumber: `DISC-2026-${id}`,
        subjectUid: 'subject-1',
        status: 'closed',
        decision: 'strike1',
        strikeNumber: 1,
        founderReview: null,
        statusHistory: [],
        ...overrides,
    });
}

describe('derived counter (T39, T40)', () => {
    test('T39 derived counter ignores legacy warnings entirely', async () => {
        const db = makeFakeDb();
        db.seed('users/subject-1', { displayName: 'S', warningCount: 3 });
        // Three legacy warning docs with no caseId: they must NOT count.
        db.seed('users/subject-1/warnings/w1', { type: 'missed-deadline', penaltyPoints: 5 });
        db.seed('users/subject-1/warnings/w2', { type: 'missed-deadline', penaltyPoints: 5 });
        db.seed('users/subject-1/warnings/w3', { type: 'missed-deadline', penaltyPoints: 5 });
        expect(await computeDerivedWarningCount(db, 'subject-1')).toBe(0);
        strikeCase(db, 'c1');
        expect(await computeDerivedWarningCount(db, 'subject-1')).toBe(1);
        // A revoked-sanction case does not count.
        strikeCase(db, 'c2', { founderReview: { outcome: 'revoke_sanction' } });
        expect(await computeDerivedWarningCount(db, 'subject-1')).toBe(1);
        // A dismissed case does not count.
        strikeCase(db, 'c3', { decision: 'dismissed', strikeNumber: null });
        expect(await computeDerivedWarningCount(db, 'subject-1')).toBe(1);
    });

    test('T40 reconciliation logs drift and corrects the stored field', async () => {
        const db = makeFakeDb();
        db.seed('users/subject-1', { displayName: 'S', warningCount: 5 });
        strikeCase(db, 'c1');
        const drift = await reconcileWarningCounts(db, NOW);
        expect(drift).toEqual([{ uid: 'subject-1', stored: 5, derived: 1 }]);
        expect(db.read('users/subject-1')?.warningCount).toBe(1);
        const audits = db.readCollection('audit_logs');
        expect(audits.some((a) => a.data.action === 'warning_count_drift')).toBe(true);
    });
});

describe('expulsion Cause validation (T27)', () => {
    function boardCase(db: any, cause: any) {
        db.seed('users/subject-1', { displayName: 'S', role: 'team_member', warningCount: 2 });
        db.seed('settings/discipline', { shadowMode: false });
        db.seed('disciplinary_cases/case-x', {
            caseId: 'case-x',
            caseNumber: 'DISC-2026-0100',
            subjectUid: 'subject-1',
            status: 'board_vote_open',
            decision: 'strike3',
            strikeNumber: 3,
            founderReview: null,
            cause,
            statusHistory: [
                { from: 'decided', to: 'board_notice_issued', byUid: 'ngs-1', byRole: 'ngs', at: NOW.toISOString() },
                { from: 'board_notice_issued', to: 'board_vote_open', byUid: 'ngs-1', byRole: 'ngs', at: NOW.toISOString() },
            ],
        });
    }

    test('T27 three_strikes requires exactly 3 valid counted cases', async () => {
        const db = makeFakeDb();
        boardCase(db, { causeType: 'three_strikes', countedCaseIds: ['p1', 'p2'], priorStrikesAtDecision: 2, grossMisconductStatement: null });
        await expect(
            applyExpulsionBan(db, 'case-x', { voteId: 'v1', votesFor: 5, votesAgainst: 1, quorumMet: true }, NOW),
        ).rejects.toMatchObject({ code: 'CAUSE_THREE_STRIKES_INVALID' });
    });

    test('T27b a revoked-sanction case in the count is rejected', async () => {
        const db = makeFakeDb();
        strikeCase(db, 'p1');
        strikeCase(db, 'p2', { founderReview: { outcome: 'revoke_sanction' } });
        boardCase(db, { causeType: 'three_strikes', countedCaseIds: ['p1', 'p2', 'case-x'], priorStrikesAtDecision: 2, grossMisconductStatement: null });
        await expect(
            applyExpulsionBan(db, 'case-x', { voteId: 'v1', votesFor: 5, votesAgainst: 1, quorumMet: true }, NOW),
        ).rejects.toMatchObject({ code: 'CAUSE_CASE_REVOKED' });
    });

    test('T27c a dismissed case in the count is rejected', async () => {
        const db = makeFakeDb();
        strikeCase(db, 'p1');
        strikeCase(db, 'p2', { decision: 'dismissed', strikeNumber: null });
        boardCase(db, { causeType: 'three_strikes', countedCaseIds: ['p1', 'p2', 'case-x'], priorStrikesAtDecision: 2, grossMisconductStatement: null });
        await expect(
            applyExpulsionBan(db, 'case-x', { voteId: 'v1', votesFor: 5, votesAgainst: 1, quorumMet: true }, NOW),
        ).rejects.toMatchObject({ code: 'CAUSE_CASE_NOT_A_STRIKE' });
    });

    test('T27d valid three_strikes cause + passed vote applies the ban', async () => {
        const db = makeFakeDb();
        strikeCase(db, 'p1');
        strikeCase(db, 'p2');
        boardCase(db, { causeType: 'three_strikes', countedCaseIds: ['p1', 'p2', 'case-x'], priorStrikesAtDecision: 2, grossMisconductStatement: null });
        const closed = await applyExpulsionBan(db, 'case-x', { voteId: 'v1', votesFor: 5, votesAgainst: 1, quorumMet: true }, NOW);
        expect(closed.status).toBe('closed');
        const user = db.read('users/subject-1');
        expect(user?.isBanned).toBe(true);
        expect(user?.bannedBy).toBe('board:v1');
        expect(user?.bannedReason).toBe('Expelled by Board vote - case DISC-2026-0100');
        expect(user?.warningCount).toBe(3);
    });

    test('T27e a tied vote never applies a ban', async () => {
        const db = makeFakeDb();
        strikeCase(db, 'p1');
        strikeCase(db, 'p2');
        boardCase(db, { causeType: 'three_strikes', countedCaseIds: ['p1', 'p2', 'case-x'], priorStrikesAtDecision: 2, grossMisconductStatement: null });
        await expect(
            applyExpulsionBan(db, 'case-x', { voteId: 'v1', votesFor: 3, votesAgainst: 3, quorumMet: true }, NOW),
        ).rejects.toMatchObject({ code: 'VOTE_NOT_PASSED' });
        expect(db.read('users/subject-1')?.isBanned).toBeFalsy();
    });
});
