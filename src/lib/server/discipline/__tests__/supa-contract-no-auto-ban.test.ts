/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 1+3.
 *
 * Invariant 1 (NO AUTO-BAN): nothing in the warnings path blacklists
 * or bans a user at 3 warnings. Derived from code, not the stale
 * Oct 10 warning guide:
 *  - direct issuance route is retired 410 (apply-decision header +
 *    src/app/api/admin/issue-warning/route.ts:7-27);
 *  - threshold-ban.ts has NO threshold writer left: the R1 write was
 *    deleted at integration (threshold-ban.ts:57-68); the module
 *    exports only read-side helpers (patterns, expulsion check, the
 *    pure R5 restoration evaluation);
 *  - the derived counter counts decided strike CASES only; legacy
 *    warning docs never count (derived-counter.ts:5-10, 22-40);
 *  - reaching warningCount 3 via three decided Strike 1 cases sets
 *    neither isBanned nor isBlacklisted; a Strike 3 DECISION alone
 *    bans nobody (it is a recommendation; only applyExpulsionBan
 *    after a passed Board vote writes isBanned=true,
 *    apply-decision.ts:378ff).
 *
 * Invariant 3 (isBlacklisted NEVER AUTO-CLEARS): the sole writer of
 * isBlacklisted in src/** is Founder reinstatement in
 * src/app/api/admin/founder-review/route.ts:174-177, writing false
 * ONLY when the ban being undone was a board ban (wasBoardBan).
 * Behavioural pins for that route live in
 * supa-contract-founder-reinstate.test.ts (route-level file).
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

import { NextRequest } from 'next/server';
import { GET as issueWarningGET, POST as issueWarningPOST } from '@/app/api/admin/issue-warning/route';
import * as thresholdBan from '@/lib/server/threshold-ban';
import { computeDerivedWarningCount } from '../derived-counter';
import { applyCaseDecision } from '../apply-decision';
import { makeFakeDb } from './fake-firestore';

const REASON = 'The hearing found the allegation proven on the evidence presented by the initiator.';
const NOW = new Date('2026-10-21T12:00:00.000Z');
const mdActor = { uid: 'md-1', offices: ['membership_director'] as any[], roleKey: 'national_membership_director', chapterId: null };
const necActor = { uid: 'nec-1', offices: ['nec'] as any[], roleKey: 'nec', chapterId: null };

function seededDb() {
    const db = makeFakeDb();
    db.seed('users/subject-1', { displayName: 'Test Subject', role: 'team_member', chapterId: 'ch-a', warningCount: 0 });
    db.seed('settings/discipline', { shadowMode: false });
    return db;
}

function hearingCase(db: any, id: string) {
    db.seed(`disciplinary_cases/${id}`, {
        caseId: id,
        caseNumber: `DISC-2026-${id}`,
        subjectUid: 'subject-1',
        subjectNameSnapshot: 'Test Subject',
        subjectRoleSnapshot: 'team_member',
        status: 'hearing',
        hearingOutcome: 'upheld',
        constitutionalGround: '10.9(a)',
        initiatedByUid: 'md-1',
        initiatedByRole: 'national_membership_director',
        strikeNumber: null,
        decision: null,
        founderReview: null,
        sanctionApplied: null,
        statusHistory: [{ from: null, to: 'initiated', byUid: 'md-1', byRole: 'x', at: NOW.toISOString() }],
    });
}

describe('CONTRACT 1a: direct warning issuance is retired (410 Gone, writes nothing)', () => {
    test('POST /api/admin/issue-warning answers 410 with the case-API successor pointer', async () => {
        const res = await issueWarningPOST(new NextRequest('http://localhost/api/admin/issue-warning', { method: 'POST', body: JSON.stringify({ userId: 'subject-1' }) }));
        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toBe('Gone');
        expect(body.successor).toBe('/api/discipline/cases');
    });
    test('GET /api/admin/issue-warning also answers 410', async () => {
        const res = await issueWarningGET(new NextRequest('http://localhost/api/admin/issue-warning'));
        expect(res.status).toBe(410);
    });
});

describe('CONTRACT 1b: threshold-ban.ts contains no threshold writer', () => {
    test('the deleted R1 writer (buildThresholdBlacklistUpdate) is not exported', () => {
        expect((thresholdBan as any).buildThresholdBlacklistUpdate).toBeUndefined();
    });
    test('module exports are exactly the read-side helpers', () => {
        expect(Object.keys(thresholdBan).sort()).toEqual(
            ['THRESHOLD_BAN_REASON_PATTERNS', 'evaluateRestoration', 'hasExpulsionRecord', 'isThresholdBanReason'].sort(),
        );
    });
    test('threshold banReason patterns are the two anchored legacy templates only', () => {
        expect(thresholdBan.isThresholdBanReason('Reached 3 warnings. Blacklisted and banned permanently.')).toBe(true);
        expect(thresholdBan.isThresholdBanReason('Exceeded 3 warnings. Auto-blacklisted.')).toBe(true);
        expect(thresholdBan.isThresholdBanReason('Reached 3 warnings. Blacklisted and banned permanently. Extra')).toBe(false);
        expect(thresholdBan.isThresholdBanReason('Expelled by Board vote - case DISC-2026-0009')).toBe(false);
        expect(thresholdBan.isThresholdBanReason(null)).toBe(false);
    });
    test('hasExpulsionRecord is false when the expulsions collection is empty/absent', async () => {
        const db = makeFakeDb();
        await expect(thresholdBan.hasExpulsionRecord(db as any, 'subject-1')).resolves.toBe(false);
        db.seed('expulsions/exp-1', { userId: 'subject-1', status: 'active' });
        await expect(thresholdBan.hasExpulsionRecord(db as any, 'subject-1')).resolves.toBe(true);
        await expect(thresholdBan.hasExpulsionRecord(db as any, 'someone-else')).resolves.toBe(false);
    });
    test('evaluateRestoration is pure evaluation: it mutates nothing and writes nothing', () => {
        const userData = { isBlacklisted: true, isBanned: true };
        const before = { ...userData };
        const decision = thresholdBan.evaluateRestoration(userData, 2, 3, { isThresholdBanReason: true, hasExpulsionRecord: false });
        expect(decision).toEqual({ clearBlacklist: true, clearBan: true });
        expect(userData).toEqual(before);
        // At/above threshold it clears neither, even as pure evaluation.
        expect(thresholdBan.evaluateRestoration(userData, 3, 3, { isThresholdBanReason: true, hasExpulsionRecord: false }))
            .toEqual({ clearBlacklist: false, clearBan: false });
    });
});

describe('CONTRACT 1c: derived warning count counts decided strike cases only', () => {
    test('legacy warnings, undecided cases and revoked cases never count', async () => {
        const db = makeFakeDb();
        // Legacy warning docs under the user: never consulted by the counter.
        db.seed('users/subject-1/warnings/legacy-1', { kind: 'legacy', caseId: undefined });
        const cases: Array<[string, Record<string, any>]> = [
            ['c-closed-strike', { subjectUid: 'subject-1', status: 'closed', strikeNumber: 1, founderReview: null }],
            ['c-applied-strike', { subjectUid: 'subject-1', status: 'sanction_applied', strikeNumber: 2, founderReview: null }],
            ['c-hearing-strike', { subjectUid: 'subject-1', status: 'hearing', strikeNumber: 1, founderReview: null }],
            ['c-closed-dismissed', { subjectUid: 'subject-1', status: 'closed', strikeNumber: null, founderReview: null }],
            ['c-closed-revoked', { subjectUid: 'subject-1', status: 'closed', strikeNumber: 1, founderReview: { outcome: 'revoke_sanction' } }],
            ['c-other-subject', { subjectUid: 'other', status: 'closed', strikeNumber: 1, founderReview: null }],
        ];
        for (const [id, data] of cases) db.seed(`disciplinary_cases/${id}`, data);
        await expect(computeDerivedWarningCount(db, 'subject-1')).resolves.toBe(2);
    });
});

describe('CONTRACT 1d: three decided Strike 1 cases do NOT blacklist or ban', () => {
    test('warningCount reaches 3 with isBanned/isBlacklisted never set', async () => {
        const db = seededDb();
        for (const id of ['case-a', 'case-b', 'case-c']) {
            hearingCase(db, id);
            const decided = await applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct' }, mdActor, NOW);
            expect(decided.status).toBe('closed');
        }
        const user = db.read('users/subject-1')!;
        expect(user.warningCount).toBe(3);
        expect(user.isBanned).toBeUndefined();
        expect(user.isBlacklisted).toBeUndefined();
        expect(user.bannedReason).toBeUndefined();
        expect(user.blacklistStatus).toBeUndefined();
        expect(db.readCollection('users/subject-1/warnings')).toHaveLength(3);
    });

    test('a Strike 3 decision alone is a recommendation: status decided, user doc untouched, no ban', async () => {
        const db = seededDb();
        const before = { ...db.read('users/subject-1')! };
        hearingCase(db, 'case-s3');
        const decided = await applyCaseDecision(db, 'case-s3', {
            decision: 'strike3',
            decisionReason: REASON,
            diagnosis: 'conduct',
            necDecisionRef: 'minutes-9',
            cause: { causeType: 'gross_misconduct', countedCaseIds: [], priorStrikesAtDecision: 0, grossMisconductStatement: 'Head 10.9(a) relied on.' },
        } as any, necActor, NOW);
        expect(decided.status).toBe('decided');
        expect(decided.strikeNumber).toBe(3);
        expect(db.read('users/subject-1')).toEqual(before);
    });

    test('a decision payload carrying isBlacklisted/isBanned is rejected outright', async () => {
        const db = seededDb();
        hearingCase(db, 'case-x');
        await expect(
            applyCaseDecision(db, 'case-x', { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct', isBlacklisted: true } as any, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'POINTS_NOT_A_SANCTION' });
        await expect(
            applyCaseDecision(db, 'case-x', { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct', isBanned: true } as any, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'POINTS_NOT_A_SANCTION' });
        expect(db.read('disciplinary_cases/case-x')?.status).toBe('hearing');
    });
});
