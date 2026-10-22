/**
 * @jest-environment node
 *
 * Grove Item 18: can't / won't diagnosis on discipline case decisions.
 *
 * Spec (seds_website_grove_optimization_comparison.md, Item 18):
 * - Add one required field `diagnosis: capability / motivation / conduct`
 *   to the discipline case-decision form.
 * - Stored on the case record, written through the existing decision
 *   path (applyCaseDecision in src/lib/server/discipline/apply-decision.ts).
 * - A decision submission without it is rejected SERVER-SIDE.
 * - Historical cases stay unset (no backfill): a case decided before
 *   this field existed must still read back cleanly at the data layer.
 *
 * These tests are written against that spec. Until the implementation
 * lands, the enforcement/persistence tests fail because applyCaseDecision
 * currently accepts payloads with no diagnosis and drops unknown keys.
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
import { applyCaseDecision } from '../apply-decision';
import { DisciplineError, getCase } from '../case-service';

const REASON = 'The hearing found the allegation proven on the evidence presented by the initiator.';
const NOW = new Date('2026-10-22T12:00:00.000Z');

const mdActor = { uid: 'md-1', offices: ['membership_director'] as any[], roleKey: 'national_membership_director', chapterId: null };
const necActor = { uid: 'ngs-1', offices: ['ngs', 'nec'] as any[], roleKey: 'national_general_secretary', chapterId: null };

function hearingCase(db: any, overrides: Record<string, any> = {}) {
    const id = overrides.caseId || 'case-1';
    db.seed(`disciplinary_cases/${id}`, {
        caseId: id,
        caseNumber: 'DISC-2026-0001',
        subjectUid: 'subject-1',
        subjectNameSnapshot: 'Test Subject',
        subjectRoleSnapshot: 'team_member',
        status: 'hearing',
        hearingOutcome: 'upheld',
        constitutionalGround: '10.9(a)',
        initiatedByUid: 'cp-1',
        initiatedByRole: 'chapter_president',
        strikeNumber: null,
        decision: null,
        founderReview: null,
        sanctionApplied: null,
        statusHistory: [{ from: null, to: 'initiated', byUid: 'cp-1', byRole: 'chapter_president', at: NOW.toISOString() }],
        ...overrides,
    });
    return id;
}

function seededDb() {
    const db = makeFakeDb();
    db.seed('users/subject-1', { displayName: 'Test Subject', role: 'team_member', chapterId: 'ch-a', warningCount: 0 });
    db.seed('settings/discipline', { shadowMode: false });
    return db;
}

/** Assert a rejection that is specifically about the diagnosis field. */
async function expectDiagnosisRejection(promise: Promise<unknown>) {
    let err: any = null;
    try {
        await promise;
    } catch (e: any) {
        err = e;
    }
    expect(err).not.toBeNull();
    expect(err).toBeInstanceOf(DisciplineError);
    expect(String(err.code)).toMatch(/DIAGNOSIS/);
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.status).toBeLessThan(500);
}

function expectCaseUndecided(db: any, id: string) {
    const kase = db.read(`disciplinary_cases/${id}`);
    expect(kase?.status).toBe('hearing');
    expect(kase?.decision).toBeNull();
    expect(db.read('users/subject-1')?.warningCount).toBe(0);
    expect(db.readCollection('users/subject-1/warnings')).toHaveLength(0);
}

describe('Item 18: diagnosis is required on every decision', () => {
    test('strike1 without diagnosis is rejected and nothing is written', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expectDiagnosisRejection(
            applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON } as any, mdActor, NOW),
        );
        expectCaseUndecided(db, id);
    });

    test('strike2 without diagnosis is rejected and nothing is written', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expectDiagnosisRejection(
            applyCaseDecision(
                db, id,
                { decision: 'strike2', decisionReason: REASON, suspensionDays: 10, necDecisionRef: 'minutes-1' } as any,
                necActor, NOW,
            ),
        );
        expectCaseUndecided(db, id);
    });

    test('dismissed without diagnosis is rejected and nothing is written', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expectDiagnosisRejection(
            applyCaseDecision(db, id, { decision: 'dismissed', decisionReason: REASON } as any, necActor, NOW),
        );
        expectCaseUndecided(db, id);
    });

    test('diagnosis: null is rejected (explicit null is not a diagnosis)', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expectDiagnosisRejection(
            applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON, diagnosis: null } as any, mdActor, NOW),
        );
        expectCaseUndecided(db, id);
    });
});

describe('Item 18: each valid diagnosis value is accepted and persisted', () => {
    test.each(['capability', 'motivation', 'conduct'] as const)(
        'strike1 with diagnosis "%s" succeeds and the value is stored on the case record',
        async (diagnosis) => {
            const db = seededDb();
            const id = hearingCase(db);
            const decided: any = await applyCaseDecision(
                db, id,
                { decision: 'strike1', decisionReason: REASON, diagnosis } as any,
                mdActor, NOW,
            );
            expect(decided.status).toBe('closed');
            expect(decided.strikeNumber).toBe(1);
            expect(decided.diagnosis).toBe(diagnosis);
            // Persisted on the stored document, not just the return value.
            expect(db.read(`disciplinary_cases/${id}`)?.diagnosis).toBe(diagnosis);
            // Sanction path is untouched: the warning still lands.
            expect(db.read('users/subject-1')?.warningCount).toBe(1);
            expect(db.readCollection('users/subject-1/warnings')).toHaveLength(1);
        },
    );

    test('strike2 with diagnosis "motivation" succeeds and persists', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        const decided: any = await applyCaseDecision(
            db, id,
            { decision: 'strike2', decisionReason: REASON, suspensionDays: 14, necDecisionRef: 'minutes-1', diagnosis: 'motivation' } as any,
            necActor, NOW,
        );
        expect(decided.status).toBe('closed');
        expect(decided.diagnosis).toBe('motivation');
        expect(db.read(`disciplinary_cases/${id}`)?.diagnosis).toBe('motivation');
    });

    test('dismissed with diagnosis "conduct" succeeds and persists', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        const decided: any = await applyCaseDecision(
            db, id,
            { decision: 'dismissed', decisionReason: REASON, diagnosis: 'conduct' } as any,
            necActor, NOW,
        );
        expect(decided.status).toBe('closed');
        expect(decided.decision).toBe('dismissed');
        expect(decided.diagnosis).toBe('conduct');
        expect(db.read(`disciplinary_cases/${id}`)?.diagnosis).toBe('conduct');
        // A dismissal still applies no sanction.
        expect(db.read('users/subject-1')?.warningCount).toBe(0);
    });
});

describe('Item 18: invalid diagnosis values are rejected', () => {
    test.each([
        ['an unknown string', 'laziness'],
        ['an empty string', ''],
        ['a non-string value', 42],
        ['a boolean value', true],
    ])('diagnosis as %s (%p) is rejected and nothing is written', async (_label, badValue) => {
        const db = seededDb();
        const id = hearingCase(db);
        await expectDiagnosisRejection(
            applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON, diagnosis: badValue } as any, mdActor, NOW),
        );
        expectCaseUndecided(db, id);
    });
});

describe('Item 18: historical cases without diagnosis still read at the data layer', () => {
    test('a decided case stored before the field existed reads back cleanly, diagnosis unset', async () => {
        const db = seededDb();
        // Exactly the shape a pre-Item-18 decided case has in Firestore:
        // decision fields present, NO diagnosis key at all.
        db.seed('disciplinary_cases/case-historical', {
            caseId: 'case-historical',
            caseNumber: 'DISC-2026-0003',
            subjectUid: 'subject-1',
            subjectNameSnapshot: 'Test Subject',
            subjectRoleSnapshot: 'team_member',
            status: 'closed',
            hearingOutcome: 'upheld',
            constitutionalGround: '10.9(a)',
            initiatedByUid: 'cp-1',
            initiatedByRole: 'chapter_president',
            decision: 'strike1',
            decisionReason: REASON,
            decidedByRole: 'membership_director',
            decidedByUid: 'md-1',
            decidedAt: '2026-10-10T12:00:00.000Z',
            strikeNumber: 1,
            founderReview: null,
            sanctionApplied: { warningRecordId: 'warn-1', suspensionDays: null, banVoteId: null },
            statusHistory: [],
        });
        const stored = db.read('disciplinary_cases/case-historical');
        expect(stored && 'diagnosis' in stored).toBe(false);

        const kase: any = await getCase(db, 'case-historical');
        expect(kase.caseId).toBe('case-historical');
        expect(kase.status).toBe('closed');
        expect(kase.decision).toBe('strike1');
        expect(kase.strikeNumber).toBe(1);
        // Unset, not fabricated: no default diagnosis is invented on read.
        expect(kase.diagnosis ?? null).toBeNull();
    });

    test('an undecided historical case in hearing state also reads back cleanly', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        const kase: any = await getCase(db, id);
        expect(kase.status).toBe('hearing');
        expect(kase.decision).toBeNull();
        expect(kase.diagnosis ?? null).toBeNull();
    });
});
