/**
 * @jest-environment node
 *
 * Spec E.11 case-service tests T1-T11 against an in-memory Firestore
 * fake with buffered transactions.
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
import { resolveActorOffices } from '../adapters';
import { createCase, getCase, transitionCase } from '../case-service';

const NARRATIVE =
    'The member repeatedly failed to discharge the duties of his office over a sustained period, despite written reminders from the chapter committee.';
const NOW = new Date('2026-10-21T10:00:00.000Z');

function seededDb() {
    const db = makeFakeDb();
    db.seed('users/subject-1', { displayName: 'Test Subject', role: 'team_member', chapterId: 'ch-a' });
    db.seed('users/cp-1', { displayName: 'Chapter President', role: 'chapter_president', chapterId: 'ch-a' });
    db.seed('roles/cp-1', { role: 'chapter_president', chapterId: 'ch-a' });
    db.seed('users/ngs-1', { displayName: 'Gen Secretary', role: 'national_general_secretary' });
    db.seed('roles/ngs-1', { role: 'national_general_secretary' });
    db.seed('users/audit-1', { displayName: 'Audit Chair', role: 'national_audit_compliance_chair' });
    db.seed('roles/audit-1', { role: 'national_audit_compliance_chair' });
    db.seed('users/md-1', { displayName: 'Membership Director', role: 'national_membership_director' });
    db.seed('roles/md-1', { role: 'national_membership_director' });
    db.seed(`users/${FOUNDER_UID}`, { displayName: 'Founder', role: 'president_national' });
    return db;
}

async function manualCase(db: any, initiatorUid = 'cp-1') {
    const actor = await resolveActorOffices(db, initiatorUid);
    return createCase(
        db,
        {
            subjectUid: 'subject-1',
            constitutionalGround: '10.9(a)',
            groundNarrative: NARRATIVE,
            proposedStrike: 1,
        },
        actor,
        NOW,
    );
}

async function noticedCase(db: any) {
    const kase = await manualCase(db);
    const ngs = await resolveActorOffices(db, 'ngs-1');
    await transitionCase(db, kase.caseId, 'notice_issued', ngs, { noticeText: 'You are alleged...' }, NOW);
    return getCase(db, kase.caseId);
}

describe('case-service (T1-T11)', () => {
    test('T1 create_case_assigns_sequential_number', async () => {
        const db = seededDb();
        const a = await manualCase(db);
        const b = await manualCase(db);
        expect(a.caseNumber).toBe('DISC-2026-0001');
        expect(b.caseNumber).toBe('DISC-2026-0002');
        expect(a.status).toBe('initiated');
    });

    test('T2 create_case_rejects_subject_founder', async () => {
        const db = seededDb();
        const actor = await resolveActorOffices(db, 'cp-1');
        await expect(
            createCase(db, { subjectUid: FOUNDER_UID, constitutionalGround: '10.9(a)', groundNarrative: NARRATIVE }, actor, NOW),
        ).rejects.toMatchObject({ code: 'FOUNDER_NOT_SUBJECT' });
    });

    test('T3 create_case_rejects_self_initiation', async () => {
        const db = seededDb();
        const actor = await resolveActorOffices(db, 'cp-1');
        await expect(
            createCase(db, { subjectUid: 'cp-1', constitutionalGround: '10.9(a)', groundNarrative: NARRATIVE }, actor, NOW),
        ).rejects.toMatchObject({ code: 'SELF_INITIATION' });
    });

    test('T4 ground_c_rejects_without_subtype', async () => {
        const db = seededDb();
        const actor = await resolveActorOffices(db, 'cp-1');
        await expect(
            createCase(db, { subjectUid: 'subject-1', constitutionalGround: '10.9(c)', groundNarrative: NARRATIVE }, actor, NOW),
        ).rejects.toMatchObject({ code: 'GROUND_C_SUBTYPE_REQUIRED' });
    });

    test('T5 ground_e_rejects_without_direction', async () => {
        const db = seededDb();
        const actor = await resolveActorOffices(db, 'cp-1');
        await expect(
            createCase(db, { subjectUid: 'subject-1', constitutionalGround: '10.9(e)', groundNarrative: NARRATIVE }, actor, NOW),
        ).rejects.toMatchObject({ code: 'GROUND_E_DIRECTION_REQUIRED' });
    });

    test('T6 ground_rejects_nonconstitutional_values', async () => {
        const db = seededDb();
        const actor = await resolveActorOffices(db, 'cp-1');
        await expect(
            createCase(
                db,
                { subjectUid: 'subject-1', constitutionalGround: 'missed_deadline' as any, groundNarrative: NARRATIVE },
                actor,
                NOW,
            ),
        ).rejects.toMatchObject({ code: 'INVALID_GROUND' });
        await expect(
            createCase(
                db,
                { subjectUid: 'subject-1', constitutionalGround: 'attendance' as any, groundNarrative: NARRATIVE },
                actor,
                NOW,
            ),
        ).rejects.toMatchObject({ code: 'INVALID_GROUND' });
    });

    test('T7 notice_issue_ngs_only', async () => {
        const db = seededDb();
        const kase = await manualCase(db);
        const cp = await resolveActorOffices(db, 'cp-1');
        await expect(
            transitionCase(db, kase.caseId, 'notice_issued', cp, { noticeText: 'Notice' }, NOW),
        ).rejects.toMatchObject({ code: 'NOTICE_NGS_ONLY' });
    });

    test('T8 notice_issue_sets_defence_due_plus_7_days_exactly', async () => {
        const db = seededDb();
        const kase = await noticedCase(db);
        expect(kase.noticeIssuedAt).toBe(NOW.toISOString());
        expect(kase.defenceDueAt).toBe(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    });

    test('T9 defence_by_non_subject_rejected', async () => {
        const db = seededDb();
        const kase = await noticedCase(db);
        const cp = await resolveActorOffices(db, 'cp-1');
        await expect(
            transitionCase(db, kase.caseId, 'defence_received', cp, { defenceText: 'Not my defence.' }, NOW),
        ).rejects.toMatchObject({ code: 'DEFENCE_SUBJECT_ONLY' });
    });

    test('T10 late_defence_recorded_not_rejected', async () => {
        const db = seededDb();
        const kase = await noticedCase(db);
        const subject = await resolveActorOffices(db, 'subject-1');
        const late = new Date(NOW.getTime() + 9 * 24 * 60 * 60 * 1000);
        const updated = await transitionCase(db, kase.caseId, 'defence_received', subject, { defenceText: 'My defence.' }, late);
        expect(updated.status).toBe('defence_received');
        expect(updated.defenceLate).toBe(true);
    });

    test('T11 hearing_officer_cannot_be_initiator', async () => {
        const db = seededDb();
        // Audit Chair initiates this case.
        const kase = await manualCase(db, 'audit-1');
        const ngs = await resolveActorOffices(db, 'ngs-1');
        await transitionCase(db, kase.caseId, 'notice_issued', ngs, { noticeText: 'Notice' }, NOW);
        const subject = await resolveActorOffices(db, 'subject-1');
        await transitionCase(db, kase.caseId, 'defence_received', subject, { defenceText: 'Defence.' }, NOW);
        const audit = await resolveActorOffices(db, 'audit-1');
        await expect(
            transitionCase(db, kase.caseId, 'hearing', audit, {}, NOW),
        ).rejects.toMatchObject({ code: 'HEARING_OFFICER_CONFLICT' });
    });
});
