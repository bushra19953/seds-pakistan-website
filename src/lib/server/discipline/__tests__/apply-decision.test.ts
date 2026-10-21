/**
 * @jest-environment node
 *
 * Spec E.11 applyCaseDecision tests: T12-T20, T41.
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

import { FOUNDER_UID } from '@/lib/roles';
import { makeFakeDb } from './fake-firestore';
import * as adapters from '../adapters';
import { applyCaseDecision, applyReviewModification } from '../apply-decision';

const REASON = 'The hearing found the allegation proven on the evidence presented by the initiator.';
const NOW = new Date('2026-10-21T12:00:00.000Z');

const cpActor = { uid: 'cp-1', offices: ['chapter_president'] as any[], roleKey: 'chapter_president', chapterId: 'ch-a' };
const cpOtherActor = { uid: 'cp-2', offices: ['chapter_president'] as any[], roleKey: 'chapter_president', chapterId: 'ch-b' };
const mdActor = { uid: 'md-1', offices: ['membership_director'] as any[], roleKey: 'national_membership_director', chapterId: null };
const necActor = { uid: 'ngs-1', offices: ['ngs', 'nec'] as any[], roleKey: 'national_general_secretary', chapterId: null };
const founderActor = { uid: FOUNDER_UID, offices: ['founder'] as any[], roleKey: 'founder', chapterId: null };

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

describe('applyCaseDecision (T12-T20)', () => {
    test('T12 strike1 by chapter president of own chapter succeeds; other chapter rejected', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expect(
            applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON }, cpOtherActor, NOW),
        ).rejects.toMatchObject({ code: 'CHAPTER_SCOPE' });
        const decided = await applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON }, cpActor, NOW);
        expect(decided.status).toBe('closed');
        expect(decided.strikeNumber).toBe(1);
    });

    test('T13 strike2 requires necDecisionRef', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expect(
            applyCaseDecision(db, id, { decision: 'strike2', decisionReason: REASON, suspensionDays: 10 }, necActor, NOW),
        ).rejects.toMatchObject({ code: 'NEC_REF_REQUIRED' });
    });

    test('T14 strike1 writes the permanent warning record (E.4.6)', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        const decided = await applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON }, mdActor, NOW);
        const warnings = db.readCollection('users/subject-1/warnings');
        expect(warnings).toHaveLength(1);
        const w = warnings[0].data;
        expect(w.kind).toBe('formal_warning');
        expect(w.caseId).toBe(id);
        expect(w.isPermanent).toBe(true);
        expect(w.expiresAt).toBeNull();
        expect(w.penaltyPoints).toBe(0);
        expect(w.pointsDeducted).toBe(0);
        expect(w.demotedToRole).toBeNull();
        expect(w.status).toBe('active');
        expect(db.read('users/subject-1')?.warningCount).toBe(1);
        expect(decided.sanctionApplied?.warningRecordId).toBe(warnings[0].id);
    });

    test('T15 strike payload carrying points is rejected', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expect(
            applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON, penaltyPoints: 5 } as any, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'POINTS_NOT_A_SANCTION' });
    });

    test('T16 decision without a sufficient reason is rejected', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await expect(
            applyCaseDecision(db, id, { decision: 'dismissed', decisionReason: 'no' }, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'DECISION_REASON_REQUIRED' });
    });

    test('T17 hearing outcome dismissed blocks a strike', async () => {
        const db = seededDb();
        const id = hearingCase(db, { hearingOutcome: 'dismissed' });
        await expect(
            applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON }, mdActor, NOW),
        ).rejects.toMatchObject({ code: 'HEARING_DISMISSED_BLOCKS_STRIKE' });
    });

    test('T18 audit failure rolls back the whole decision', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        const spy = jest
            .spyOn(adapters, 'writeGovernanceAuditOrThrow')
            .mockRejectedValueOnce(new Error('audit store down'));
        try {
            await expect(
                applyCaseDecision(db, id, { decision: 'strike1', decisionReason: REASON }, mdActor, NOW),
            ).rejects.toThrow('audit store down');
        } finally {
            spy.mockRestore();
        }
        const kase = db.read(`disciplinary_cases/${id}`);
        expect(kase?.status).toBe('hearing');
        expect(kase?.decision).toBeNull();
        expect(db.read('users/subject-1')?.warningCount).toBe(0);
        expect(db.readCollection('users/subject-1/warnings')).toHaveLength(0);
    });

    test('T19 suspension days bounds: 0 and 61 rejected, 1 and 60 accepted', async () => {
        for (const bad of [0, 61]) {
            const db = seededDb();
            const id = hearingCase(db);
            await expect(
                applyCaseDecision(db, id, { decision: 'strike2', decisionReason: REASON, suspensionDays: bad, necDecisionRef: 'minutes-1' }, necActor, NOW),
            ).rejects.toMatchObject({ code: 'SUSPENSION_DAYS_BOUNDS' });
        }
        for (const good of [1, 60]) {
            const db = seededDb();
            const id = hearingCase(db);
            const decided = await applyCaseDecision(
                db, id,
                { decision: 'strike2', decisionReason: REASON, suspensionDays: good, necDecisionRef: 'minutes-1' },
                necActor, NOW,
            );
            expect(decided.status).toBe('closed');
            expect(decided.suspensionDays).toBe(good);
        }
    });

    test('T20 strike2 never sets isBanned or isOnProbation', async () => {
        const db = seededDb();
        const id = hearingCase(db);
        await applyCaseDecision(
            db, id,
            { decision: 'strike2', decisionReason: REASON, suspensionDays: 14, necDecisionRef: 'minutes-1' },
            necActor, NOW,
        );
        const user = db.read('users/subject-1');
        expect(user?.isBanned).toBeFalsy();
        expect(user?.isOnProbation).toBeFalsy();
        expect(user?.suspensionCaseId).toBe(id);
        expect(user?.privilegesSuspendedUntil).toBeTruthy();
        expect(user?.warningCount).toBe(1);
    });
});

describe('applyReviewModification (T41)', () => {
    test('T41 modify cannot increase a sanction', async () => {
        const db = seededDb();
        db.seed('disciplinary_cases/case-s2', {
            caseId: 'case-s2',
            caseNumber: 'DISC-2026-0007',
            subjectUid: 'subject-1',
            status: 'closed',
            decision: 'strike2',
            strikeNumber: 2,
            suspensionDays: 30,
            founderReview: null,
            statusHistory: [],
        });
        await expect(
            applyReviewModification(db, 'case-s2', { newStrike: 2, newSuspensionDays: 10 }, founderActor, NOW),
        ).rejects.toMatchObject({ code: 'MODIFY_INCREASE_FORBIDDEN' });
        // Reduce 2 -> 1 works and clears the suspension.
        const updated = await applyReviewModification(db, 'case-s2', { newStrike: 1 }, founderActor, NOW);
        expect(updated.strikeNumber).toBe(1);
        const user = db.read('users/subject-1');
        expect(user?.suspensionCaseId).toBeNull();
    });

    test('T41b strike3 reduced to strike2 clears the board ban', async () => {
        const db = seededDb();
        db.seed('users/subject-1', {
            displayName: 'Test Subject', role: 'team_member', chapterId: 'ch-a', warningCount: 3,
            isBanned: true, bannedBy: 'board:vote-9', bannedReason: 'Expelled by Board vote - case DISC-2026-0009',
        });
        db.seed('disciplinary_cases/case-s3', {
            caseId: 'case-s3',
            caseNumber: 'DISC-2026-0009',
            subjectUid: 'subject-1',
            status: 'closed',
            decision: 'strike3',
            strikeNumber: 3,
            founderReview: null,
            statusHistory: [],
        });
        const updated = await applyReviewModification(db, 'case-s3', { newStrike: 2, newSuspensionDays: 20 }, founderActor, NOW);
        expect(updated.strikeNumber).toBe(2);
        const user = db.read('users/subject-1');
        expect(user?.isBanned).toBe(false);
        expect(user?.suspensionCaseId).toBe('case-s3');
    });
});
