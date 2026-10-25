/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 2.
 *
 * Invariant 2 (WARNING = STRIKE 1 OF A DECIDED CASE): the only path
 * that creates a warning is applyCaseDecision in
 * src/lib/server/discipline/apply-decision.ts. Exact write set pinned
 * from the code:
 *  - Strike 1, shadow OFF (apply-decision.ts:262-290): case doc ->
 *    closed via the decided->sanction_applied->closed history chain
 *    (case-service.ts decisionTransitionFields), ONE doc in
 *    users/{uid}/warnings with the 16-field formal_warning shape,
 *    users/{uid}.warningCount = derivedBefore+1, and a
 *    'discipline.decision' governance audit row INSIDE the same
 *    transaction. No probation_restores doc is written by a decision,
 *    and no other user field changes.
 *  - Shadow mode ON (settings/discipline shadowMode; apply-decision
 *    header + :246-259): the decision is recorded, shadowWouldApply
 *    is populated, sanctionAppliedAt is null, and the users doc /
 *    warnings subcollection are NEVER touched.
 *  - Strike 2 (:291-306): no warning doc; user gets the three
 *    suspension fields + warningCount; the case doc additionally
 *    carries suspensionCaseId/Days/Reason/StartsAt/EndsAt.
 *  - dismissed / no_case: no warning doc, no user sanction fields;
 *    the case closes with an all-null sanctionApplied.
 *  - Preconditions: case must be in 'hearing'
 *    (CASE_NOT_IN_HEARING), decisionReason >= 30 chars, and a valid
 *    diagnosis is mandatory on EVERY decision (Item 18).
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

import { applyCaseDecision } from '../apply-decision';
import { makeFakeDb } from './fake-firestore';

const REASON = 'The hearing found the allegation proven on the evidence presented by the initiator.';
const NOW = new Date('2026-10-21T12:00:00.000Z');
const ISO = NOW.toISOString();
const mdActor = { uid: 'md-1', offices: ['membership_director'] as any[], roleKey: 'national_membership_director', chapterId: null };
const necActor = { uid: 'nec-1', offices: ['nec'] as any[], roleKey: 'nec', chapterId: null };
const initiatorActor = { uid: 'cp-1', offices: [] as any[], roleKey: 'chapter_president', chapterId: 'ch-a' };

const USER_SEED = { displayName: 'Test Subject', role: 'team_member', chapterId: 'ch-a', warningCount: 0, points: 42 };

function seededDb(shadowMode = false) {
    const db = makeFakeDb();
    db.seed('users/subject-1', { ...USER_SEED });
    db.seed('settings/discipline', { shadowMode });
    db.seed('disciplinary_cases/case-1', {
        caseId: 'case-1',
        caseNumber: 'DISC-2026-0001',
        subjectUid: 'subject-1',
        subjectNameSnapshot: 'Test Subject',
        subjectRoleSnapshot: 'team_member',
        category: null,
        status: 'hearing',
        hearingOutcome: 'upheld',
        constitutionalGround: '10.9(b)',
        initiatedByUid: 'cp-1',
        initiatedByRole: 'chapter_president',
        strikeNumber: null,
        decision: null,
        founderReview: null,
        sanctionApplied: null,
        necDecisionRef: null,
        statusHistory: [{ from: null, to: 'initiated', byUid: 'cp-1', byRole: 'chapter_president', at: ISO }],
    });
    return db;
}

describe('CONTRACT 2a: Strike 1 write set is exactly case + warning + user.warningCount + audit', () => {
    test('strike1 (shadow off) writes the exact formal_warning shape and nothing else on the user', async () => {
        const db = seededDb(false);
        const decided = await applyCaseDecision(db, 'case-1', { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct' }, mdActor, NOW);

        // Case: closed via the 3-step decision history chain.
        expect(decided.status).toBe('closed');
        expect(decided.closedAt).toBe(ISO);
        expect(decided.decision).toBe('strike1');
        expect(decided.strikeNumber).toBe(1);
        expect(decided.category).toBe('warning_only');
        expect(decided.decidedByRole).toBe('membership_director');
        expect(decided.decidedByUid).toBe('md-1');
        expect(decided.decidedAt).toBe(ISO);
        expect(decided.diagnosis).toBe('conduct');
        expect(decided.sanctionAppliedAt).toBe(ISO);
        expect((decided.statusHistory || []).map((h: any) => h.to)).toEqual(['initiated', 'decided', 'sanction_applied', 'closed']);

        // Warning: exactly one, exactly these 16 fields.
        const warnings = db.readCollection('users/subject-1/warnings');
        expect(warnings).toHaveLength(1);
        const w = warnings[0].data;
        expect(Object.keys(w).sort()).toEqual([
            'caseId', 'caseNumber', 'demotedToRole', 'description', 'expiresAt', 'ground',
            'issuedAt', 'issuedByRole', 'issuedByUid', 'isPermanent', 'kind', 'penaltyPoints',
            'pointsDeducted', 'status', 'strikeNumber', 'title',
        ].sort());
        expect(w.kind).toBe('formal_warning');
        expect(w.caseId).toBe('case-1');
        expect(w.caseNumber).toBe('DISC-2026-0001');
        expect(w.strikeNumber).toBe(1);
        expect(w.ground).toBe('10.9(b)');
        expect(w.title).toBe('Formal warning - DISC-2026-0001');
        expect(w.description).toBe(REASON);
        expect(w.issuedByUid).toBe('md-1');
        expect(w.issuedByRole).toBe('membership_director');
        expect(w.issuedAt?.toDate?.().toISOString() ?? w.issuedAt).toBeTruthy();
        expect(w.isPermanent).toBe(true);
        expect(w.expiresAt).toBeNull();
        expect(w.status).toBe('active');
        expect(w.pointsDeducted).toBe(0);
        expect(w.penaltyPoints).toBe(0);
        expect(w.demotedToRole).toBeNull();
        expect(decided.sanctionApplied).toEqual({ warningRecordId: warnings[0].id, suspensionDays: null, banVoteId: null });

        // User: warningCount is the ONLY changed field.
        expect(db.read('users/subject-1')).toEqual({ ...USER_SEED, warningCount: 1 });

        // No probation restore is created by a case decision.
        expect(db.readCollection('probation_restores')).toHaveLength(0);

        // Audit row written in the decision transaction.
        const audits = db.readCollection('audit_logs').map((a) => a.data);
        expect(audits.some((a) => a.action === 'discipline.decision' && a.targetId === 'case-1' && a.details?.decision === 'strike1' && a.details?.shadow === false)).toBe(true);
    });

    test('shadow mode records the decision but touches neither the user nor warnings', async () => {
        const db = seededDb(true);
        const decided = await applyCaseDecision(db, 'case-1', { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct' }, mdActor, NOW);
        expect(decided.status).toBe('closed');
        expect(decided.sanctionAppliedAt).toBeNull();
        expect(decided.sanctionApplied).toEqual({ warningRecordId: null, suspensionDays: null, banVoteId: null });
        expect(decided.shadowWouldApply).toEqual({ decision: 'strike1', suspensionDays: null, warningCountWouldBecome: 1 });
        expect(db.readCollection('users/subject-1/warnings')).toHaveLength(0);
        expect(db.read('users/subject-1')).toEqual(USER_SEED);
    });
});

describe('CONTRACT 2b: Strike 2 and dismissal write sets', () => {
    test('strike2 writes suspension fields + warningCount, and NO warning doc', async () => {
        const db = seededDb(false);
        const decided = await applyCaseDecision(db, 'case-1', { decision: 'strike2', decisionReason: REASON, diagnosis: 'motivation', suspensionDays: 10, necDecisionRef: 'nec-min-1' }, necActor, NOW);
        expect(decided.status).toBe('closed');
        expect(decided.category).toBe('suspension');
        expect(decided.suspensionDays).toBe(10);
        expect(decided.suspensionCaseId).toBe('case-1');
        expect(decided.suspensionReason).toBe(REASON.slice(0, 200));
        expect(decided.suspensionStartsAt).toBe(ISO);
        expect(decided.suspensionEndsAt).toBe(new Date(NOW.getTime() + 10 * 86400000).toISOString());
        expect(db.readCollection('users/subject-1/warnings')).toHaveLength(0);
        const user = db.read('users/subject-1')!;
        expect(user.warningCount).toBe(1);
        expect(user.suspensionCaseId).toBe('case-1');
        expect(user.suspendedFrom).toBeTruthy();
        expect(user.privilegesSuspendedUntil).toBeTruthy();
        expect(user.isBanned).toBeUndefined();
        expect(user.isBlacklisted).toBeUndefined();
    });

    test('dismissed writes no warning and no user field; case closes with all-null sanctionApplied', async () => {
        const db = seededDb(false);
        const decided = await applyCaseDecision(db, 'case-1', { decision: 'dismissed', decisionReason: REASON, diagnosis: 'capability' }, initiatorActor, NOW);
        expect(decided.status).toBe('closed');
        expect(decided.decision).toBe('dismissed');
        expect(decided.strikeNumber).toBeNull();
        expect(decided.sanctionApplied).toEqual({ warningRecordId: null, suspensionDays: null, banVoteId: null });
        expect(db.readCollection('users/subject-1/warnings')).toHaveLength(0);
        expect(db.read('users/subject-1')).toEqual(USER_SEED);
    });
});

describe('CONTRACT 2c: decision preconditions', () => {
    test('a decision from any status other than hearing is rejected and writes nothing', async () => {
        const db = seededDb(false);
        db.seed('disciplinary_cases/case-1', { ...(db.read('disciplinary_cases/case-1') as any), status: 'notice_issued' });
        await expect(
            applyCaseDecision(db, 'case-1', { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct' }, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'CASE_NOT_IN_HEARING' });
        expect(db.readCollection('users/subject-1/warnings')).toHaveLength(0);
        expect(db.read('users/subject-1')).toEqual(USER_SEED);
    });

    test('every decision requires a valid diagnosis, including dismissals', async () => {
        const db = seededDb(false);
        await expect(
            applyCaseDecision(db, 'case-1', { decision: 'dismissed', decisionReason: REASON } as any, initiatorActor, NOW),
        ).rejects.toMatchObject({ code: 'DIAGNOSIS_REQUIRED' });
        await expect(
            applyCaseDecision(db, 'case-1', { decision: 'strike1', decisionReason: REASON, diagnosis: 'unknown' as any }, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'DIAGNOSIS_REQUIRED' });
    });

    test('points/demotion payload keys are rejected as outcomes (Z-08)', async () => {
        const db = seededDb(false);
        for (const key of ['points', 'penaltyPoints', 'pointsDeducted', 'demoteToRole', 'demotion']) {
            await expect(
                applyCaseDecision(db, 'case-1', { decision: 'strike1', decisionReason: REASON, diagnosis: 'conduct', [key]: 5 } as any, mdActor, NOW),
            ).rejects.toMatchObject({ code: 'POINTS_NOT_A_SANCTION' });
        }
        expect(db.read('disciplinary_cases/case-1')?.status).toBe('hearing');
    });
});
