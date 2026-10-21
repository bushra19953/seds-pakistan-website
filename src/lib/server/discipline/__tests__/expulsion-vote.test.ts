/**
 * @jest-environment node
 *
 * Spec E.11 Strike 3 tests: T24 (notice period), T25 (tie fails),
 * T26 (quorum frozen at open), T28 (passed vote is the ban path;
 * failed vote applies nothing).
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
import { getCase, transitionCase } from '../case-service';
import { castBallot, closeExpulsionVote, openExpulsionVote, tallyBallots } from '../vote-adapter';

const T0 = new Date('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ngsActor = { uid: 'ngs-1', offices: ['ngs'] as any[], roleKey: 'national_general_secretary', chapterId: null };

function seedGovernors(db: any, n: number) {
    for (let i = 1; i <= n; i++) db.seed(`governors/seat-${i}`, { uid: `g${i}` });
}

function seedDecidedCase(db: any) {
    db.seed('users/subject-1', { displayName: 'S', role: 'team_member', warningCount: 2 });
    db.seed('settings/discipline', { shadowMode: false });
    db.seed('disciplinary_cases/p1', { caseId: 'p1', subjectUid: 'subject-1', status: 'closed', decision: 'strike1', strikeNumber: 1, founderReview: null, statusHistory: [] });
    db.seed('disciplinary_cases/p2', { caseId: 'p2', subjectUid: 'subject-1', status: 'closed', decision: 'strike2', strikeNumber: 2, founderReview: null, statusHistory: [] });
    db.seed('disciplinary_cases/case-x', {
        caseId: 'case-x',
        caseNumber: 'DISC-2026-0100',
        subjectUid: 'subject-1',
        status: 'decided',
        decision: 'strike3',
        strikeNumber: 3,
        founderReview: null,
        sanctionApplied: null,
        initiatedByUid: 'ngs-1',
        cause: { causeType: 'three_strikes', countedCaseIds: ['p1', 'p2', 'case-x'], priorStrikesAtDecision: 2, grossMisconductStatement: null },
        statusHistory: [{ from: 'hearing', to: 'decided', byUid: 'ngs-1', byRole: 'nec', at: T0.toISOString() }],
    });
}

async function openFlow(db: any) {
    seedDecidedCase(db);
    seedGovernors(db, 5);
    await transitionCase(db, 'case-x', 'board_notice_issued', ngsActor, {}, T0);
    const openAt = new Date(T0.getTime() + 7 * DAY);
    await transitionCase(db, 'case-x', 'board_vote_open', ngsActor, {}, openAt);
    const voteId = await openExpulsionVote(db, 'case-x', openAt);
    return { voteId, openAt };
}

describe('Strike 3 board flow (T24-T28)', () => {
    test('T24 board notice period enforced: +6d rejected, +7d opens', async () => {
        const db = makeFakeDb();
        seedDecidedCase(db);
        seedGovernors(db, 5);
        await transitionCase(db, 'case-x', 'board_notice_issued', ngsActor, {}, T0);
        await expect(
            transitionCase(db, 'case-x', 'board_vote_open', ngsActor, {}, new Date(T0.getTime() + 6 * DAY)),
        ).rejects.toMatchObject({ code: 'BOARD_NOTICE_PERIOD', status: 409 });
        const opened = await transitionCase(db, 'case-x', 'board_vote_open', ngsActor, {}, new Date(T0.getTime() + 7 * DAY));
        expect(opened.status).toBe('board_vote_open');
        expect(opened.boardVoteOpensAt).toBe(new Date(T0.getTime() + 7 * DAY).toISOString());
    });

    test('T24b vote open with no seated Board returns BOARD_NOT_SEATED', async () => {
        const db = makeFakeDb();
        seedDecidedCase(db);
        await transitionCase(db, 'case-x', 'board_notice_issued', ngsActor, {}, T0);
        await expect(
            transitionCase(db, 'case-x', 'board_vote_open', ngsActor, {}, new Date(T0.getTime() + 7 * DAY)),
        ).rejects.toMatchObject({ code: 'BOARD_NOT_SEATED', status: 409 });
    });

    test('T25 vote tie fails; abstentions are not in the denominator', () => {
        const tie = tallyBallots([{ choice: 'for' }, { choice: 'against' }, { choice: 'abstain' }], { quorumRequired: 3 });
        expect(tie.participating).toBe(3);
        expect(tie.quorumMet).toBe(true);
        expect(tie.passed).toBe(false);
        const pass = tallyBallots([{ choice: 'for' }, { choice: 'for' }, { choice: 'against' }], { quorumRequired: 3 });
        expect(pass.passed).toBe(true);
        const noQuorum = tallyBallots([{ choice: 'for' }, { choice: 'for' }], { quorumRequired: 5 });
        expect(noQuorum.quorumMet).toBe(false);
        expect(noQuorum.passed).toBe(false);
    });

    test('T26 quorum is frozen at open', async () => {
        const db = makeFakeDb();
        const { voteId } = await openFlow(db);
        const voteDoc = db.read(`governance_votes/${voteId}`);
        expect(voteDoc?.quorumRequired).toBe(3); // majority of 5 seated, min 3
        expect(voteDoc?.electorateSnapshot).toHaveLength(5);
        // A governor seated AFTER the open does not change the snapshot.
        db.seed('governors/seat-6', { uid: 'g6' });
        const after = db.read(`governance_votes/${voteId}`);
        expect(after?.quorumRequired).toBe(3);
        expect(after?.electorateSnapshot).toHaveLength(5);
        await expect(castBallot(db, voteId, 'g6', 'for')).rejects.toMatchObject({ code: 'VOTER_NOT_IN_ELECTORATE' });
    });

    test('T28a passed vote applies the ban through applyExpulsionBan', async () => {
        const db = makeFakeDb();
        const { voteId, openAt } = await openFlow(db);
        await castBallot(db, voteId, 'g1', 'for');
        await castBallot(db, voteId, 'g2', 'for');
        await castBallot(db, voteId, 'g3', 'for');
        await castBallot(db, voteId, 'g4', 'against');
        const result = await closeExpulsionVote(db, voteId, ngsActor, openAt);
        expect(result.passed).toBe(true);
        const user = db.read('users/subject-1');
        expect(user?.isBanned).toBe(true);
        expect(user?.bannedBy).toBe(`board:${voteId}`);
        const kase = await getCase(db, 'case-x');
        expect(kase.status).toBe('closed');
        expect(kase.sanctionApplied?.banVoteId).toBe(voteId);
        // Idempotent close: a second close returns the stored result.
        const again = await closeExpulsionVote(db, voteId, ngsActor, openAt);
        expect(again.passed).toBe(true);
    });

    test('T28b failed vote applies NO sanction and clears the recommended strike', async () => {
        const db = makeFakeDb();
        const { voteId, openAt } = await openFlow(db);
        await castBallot(db, voteId, 'g1', 'for');
        await castBallot(db, voteId, 'g2', 'against');
        await castBallot(db, voteId, 'g3', 'against');
        const result = await closeExpulsionVote(db, voteId, ngsActor, openAt);
        expect(result.passed).toBe(false);
        const user = db.read('users/subject-1');
        expect(user?.isBanned).toBeFalsy();
        const kase = await getCase(db, 'case-x');
        expect(kase.status).toBe('closed');
        expect(kase.strikeNumber).toBeNull();
        expect(kase.sanctionApplied).toBeNull();
    });
});
