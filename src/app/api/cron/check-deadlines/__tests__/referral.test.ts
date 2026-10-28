/**
 * @jest-environment node
 *
 * Spec E.11 cron conversion tests: T29-T36.
 * Route-level (T29, T30, T31, T36) + service-level referral flow
 * (T32-T35) against the in-memory fake Firestore.
 */
import { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';

let mockDb: any;
jest.mock('@/lib/server/firebase-admin', () => ({
    getDb: () => mockDb,
    ensureAdminInitialized: () => true,
    admin: {},
    adminDb: null,
    getAdminStorage: () => null,
    getLastAdminError: () => null,
    getAdminDiagnostics: () => ({}),
}));
jest.mock('@/lib/auth-middleware', () => ({
    verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));
jest.mock('@/lib/server/notification-service', () => ({
    notificationService: { send: jest.fn(async () => undefined) },
}));

import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';
import { evaluateReferralPatterns, recordMiss } from '@/lib/server/discipline/miss-records';
import { confirmDraft, dismissDraft } from '@/lib/server/discipline/referral';
import { GET } from '../route';

process.env.CRON_SECRET = 'test-secret';
const NOW = new Date('2026-10-21T12:00:00.000Z');
const PAST = new Date('2026-10-15T12:00:00.000Z');

function cronReq() {
    return new NextRequest('http://localhost/api/cron/check-deadlines', {
        headers: { authorization: 'Bearer test-secret' },
    });
}

function baseDb() {
    const db = makeFakeDb();
    db.seed('settings/discipline', { cronReferralLive: true, referralWindowDays: 28, referralMissThreshold: 3, shadowMode: true });
    db.seed('users/subject-1', { displayName: 'Subject One', role: 'team_member', warningCount: 0 });
    db.seed('users/assigner-1', { displayName: 'Assigner One', role: 'national_vp_operations' });
    return db;
}

function overdueTask(db: any, id: string, overrides: Record<string, any> = {}) {
    db.seed(`tasks/${id}`, {
        status: 'pending',
        title: `Task ${id}`,
        deadline: Timestamp.fromDate(PAST),
        assigneeId: 'subject-1',
        assignedBy: 'assigner-1',
        ...overrides,
    });
}

describe('check-deadlines conversion (route level)', () => {
    beforeEach(() => {
        mockDb = baseDb();
    });

    test('T29 miss record is idempotent across runs', async () => {
        overdueTask(mockDb, 'task-1');
        const res1 = await GET(cronReq());
        expect(res1.status).toBe(200);
        const body1 = await res1.json();
        expect(body1.missRecordsCreated).toBe(1);
        const records = mockDb.readCollection('deadline_miss_records');
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe('miss_task-1_subject-1');
        expect(records[0].data.status).toBe('recorded');
        // Second run: the task is stamped processed; no duplicate record.
        const res2 = await GET(cronReq());
        const body2 = await res2.json();
        expect(body2.missRecordsCreated).toBe(0);
        expect(mockDb.readCollection('deadline_miss_records')).toHaveLength(1);
        // Direct double-write is also idempotent.
        const again = await recordMiss(mockDb, { taskId: 'task-1', subjectUid: 'subject-1' }, NOW);
        expect(again.created).toBe(false);
    });

    test('T30 proof-uploaded task produces no miss record', async () => {
        overdueTask(mockDb, 'task-proof', { deliverableFiles: [{ downloadUrl: 'https://example.com/proof.pdf' }] });
        const res = await GET(cronReq());
        const body = await res.json();
        expect(body.missRecordsCreated).toBe(0);
        expect(mockDb.readCollection('deadline_miss_records')).toHaveLength(0);
    });

    test('T31 approved leave covering the deadline produces no miss record', async () => {
        mockDb.seed('users/subject-1', {
            displayName: 'Subject One', role: 'team_member', warningCount: 0,
            isOnVacation: true, vacationStartDate: '2026-10-01', vacationEndDate: '2026-10-31',
        });
        // The exemption is judged from the granted leave RECORD
        // (leave_requests), not from the user-doc flags above: the
        // flags are cleared when the member returns, the record is
        // what keeps an in-window deadline exempt.
        mockDb.seed('leave_requests/leave-1', {
            userId: 'subject-1', status: 'approved', leaveType: 'annual',
            startDate: '2026-10-01', endDate: '2026-10-31', reason: 'test leave',
        });
        overdueTask(mockDb, 'task-leave');
        const res = await GET(cronReq());
        const body = await res.json();
        expect(body.missRecordsCreated).toBe(0);
        expect(mockDb.readCollection('deadline_miss_records')).toHaveLength(0);
    });

    test('T31b vacation flags WITHOUT a granted leave record do NOT exempt', async () => {
        // Regression pin for the record-based rule: the old helper
        // exempted on the live flags alone. Flags with no approved
        // leave record behind them must record the miss.
        mockDb.seed('users/subject-1', {
            displayName: 'Subject One', role: 'team_member', warningCount: 0,
            isOnVacation: true, vacationStartDate: '2026-10-01', vacationEndDate: '2026-10-31',
        });
        overdueTask(mockDb, 'task-flags-only');
        const res = await GET(cronReq());
        const body = await res.json();
        expect(body.missRecordsCreated).toBe(1);
        expect(mockDb.readCollection('deadline_miss_records')).toHaveLength(1);
    });

    test('T36 the converted cron writes ZERO warnings, points, or bans', async () => {
        overdueTask(mockDb, 'task-1');
        const res = await GET(cronReq());
        const body = await res.json();
        expect(body.warningsIssued).toBe(0);
        expect(body.blacklistsTriggered).toBe(0);
        expect(mockDb.readCollection('users/subject-1/warnings')).toHaveLength(0);
        const user = mockDb.read('users/subject-1');
        expect(user?.warningCount).toBe(0);
        expect(user?.isBanned).toBeFalsy();
        expect(user?.isBlacklisted).toBeFalsy();
    });
});

describe('referral drafter + human confirm/dismiss (service level)', () => {
    async function seedPattern(db: any) {
        for (const id of ['task-a', 'task-b', 'task-c']) {
            db.seed(`tasks/${id}`, { status: 'overdue', title: `Task ${id}`, assignedBy: 'assigner-1' });
            await recordMiss(db, { taskId: id, subjectUid: 'subject-1', taskTitleSnapshot: `Task ${id}` }, NOW);
        }
    }

    test('T32 three misses create exactly ONE draft; T33 ground unset, human initiator, never system', async () => {
        const db = baseDb();
        await seedPattern(db);
        const result = await evaluateReferralPatterns(db, NOW);
        expect(result.draftsCreated).toBe(1);
        const cases = db.readCollection('disciplinary_cases');
        expect(cases).toHaveLength(1);
        const draft = cases[0].data;
        expect(draft.status).toBe('notice_draft');
        expect(draft.initiationSource).toBe('cron_referral');
        expect(draft.constitutionalGround).toBeNull();
        expect(draft.initiatedByUid).toBe('assigner-1');
        expect(draft.initiatedByUid).not.toBe('system');
        expect(draft.drafterNote).toBe('Pattern referral: 3 missed deadlines in 28 days. A human initiator must set the constitutional ground or dismiss.');
        expect(draft.linkedMissRecordIds).toHaveLength(3);
        const misses = db.readCollection('deadline_miss_records');
        expect(misses.every((m) => m.data.status === 'attached_to_draft')).toBe(true);
        // A second evaluation creates no second draft.
        const again = await evaluateReferralPatterns(db, NOW);
        expect(again.draftsCreated).toBe(0);
        expect(db.readCollection('disciplinary_cases')).toHaveLength(1);
    });

    test('T34/T35 dismissing a draft marks the linked misses dismissed_pattern', async () => {
        const db = baseDb();
        await seedPattern(db);
        const { draftCaseIds } = await evaluateReferralPatterns(db, NOW);
        const actor = { uid: 'assigner-1', offices: [] as any[], roleKey: 'national_vp_operations', chapterId: null };
        const dismissed = await dismissDraft(
            db, draftCaseIds[0], actor,
            'The misses were caused by a chapter scheduling error, not member fault.',
            NOW,
        );
        expect(dismissed.status).toBe('dismissed');
        const misses = db.readCollection('deadline_miss_records');
        expect(misses.every((m) => m.data.status === 'dismissed_pattern')).toBe(true);
    });

    test('confirm sets the ground and attaches the misses to the case', async () => {
        const db = baseDb();
        await seedPattern(db);
        const { draftCaseIds } = await evaluateReferralPatterns(db, NOW);
        const actor = { uid: 'assigner-1', offices: [] as any[], roleKey: 'national_vp_operations', chapterId: null };
        const confirmed = await confirmDraft(db, draftCaseIds[0], actor, {
            constitutionalGround: '10.9(c)',
            groundCSubtype: 'chapter_bylaws',
            groundNarrative: 'The member missed three consecutive assigned deadlines recorded by the chapter task system in October.',
            proposedStrike: 1,
        }, NOW);
        expect(confirmed.constitutionalGround).toBe('10.9(c)');
        expect(confirmed.status).toBe('notice_draft');
        const misses = db.readCollection('deadline_miss_records');
        expect(misses.every((m) => m.data.status === 'attached_to_case')).toBe(true);
    });
});
