/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 4.
 *
 * Invariant 4 (CASE STATE MACHINE): the exact states and allowed
 * transitions are those in case-service.ts TRANSITIONS (:417-433):
 *   initiated -> notice_draft (initiator offices)
 *   initiated|notice_draft -> notice_issued (NGS; Founder only as
 *     substitute when the subject is the NGS holder or NGS is vacant)
 *   notice_issued -> defence_received (subject only)
 *   notice_issued -> defence_window_closed (system only)
 *   defence_received|defence_window_closed -> hearing (Audit Chair)
 *   hearing -> decided (INTERNAL: transitionCase rejects it with
 *     USE_DECISION_PATH; only applyCaseDecision moves a case out of
 *     hearing, to closed — or to decided for strike3)
 *   decided -> board_notice_issued (NGS, strike3 only)
 *   board_notice_issued -> board_vote_open (NGS or Founder, never
 *     before boardVoteOpensAt = notice + 7d, and only with >= 3
 *     seated governors)
 *   board_vote_open -> board_decided (system)
 *   board_decided -> decided_outcome_failed (system)
 *   decided|board_decided -> sanction_applied (INTERNAL)
 *   sanction_applied|decided_outcome_failed -> closed (system)
 *   initiated|notice_draft|notice_issued|defence_received|
 *     defence_window_closed|hearing -> dismissed (initiator offices)
 * 'closed' and 'dismissed' are TERMINAL: no outgoing transitions
 * (CASE_TERMINAL). Founder review is NOT a status: requesting it
 * (request-founder-review route) changes no case status, writes no
 * appealStatus, is subject-only, decided-statuses only, and is
 * rate-limited to one request per case per 30 days (429).
 */
let mockDb: any;
let mockAuth: any;
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
    verifyAuthentication: jest.fn(async () => mockAuth),
}));
jest.mock('@/lib/server/notification-service', () => ({
    notificationService: { send: jest.fn(async () => undefined) },
}));

import { NextRequest } from 'next/server';
import { makeFakeDb } from './fake-firestore';
import { resolveActorOffices } from '../adapters';
import { createCase, expireStaleDrafts, getCase, transitionCase } from '../case-service';
import { POST as requestReviewPOST } from '@/app/api/discipline/request-founder-review/route';

const NARRATIVE = 'The member repeatedly failed to discharge the duties of his office over a sustained period, despite written reminders from the chapter committee.';
const NOW = new Date('2026-10-21T10:00:00.000Z');
const DAY = 86400000;
const DISMISS_REASON = 'The allegation does not meet the threshold for a disciplinary case on these facts.';

function seededDb() {
    const db = makeFakeDb();
    db.seed('users/subject-1', { displayName: 'Test Subject', role: 'team_member', chapterId: 'ch-a' });
    db.seed('users/cp-1', { displayName: 'Chapter President', role: 'chapter_president', chapterId: 'ch-a' });
    db.seed('roles/cp-1', { role: 'chapter_president', chapterId: 'ch-a' });
    db.seed('users/ngs-1', { displayName: 'Gen Secretary', role: 'national_general_secretary' });
    db.seed('roles/ngs-1', { role: 'national_general_secretary' });
    db.seed('users/audit-1', { displayName: 'Audit Chair', role: 'national_audit_compliance_chair' });
    db.seed('roles/audit-1', { role: 'national_audit_compliance_chair' });
    return db;
}

async function manualCase(db: any) {
    const actor = await resolveActorOffices(db, 'cp-1');
    return createCase(db, { subjectUid: 'subject-1', constitutionalGround: '10.9(a)', groundNarrative: NARRATIVE, proposedStrike: 1 }, actor, NOW);
}

function seedCaseAt(db: any, id: string, status: string, overrides: Record<string, any> = {}) {
    db.seed(`disciplinary_cases/${id}`, {
        caseId: id, caseNumber: `DISC-2026-${id}`, subjectUid: 'subject-1',
        status, initiatedByUid: 'cp-1', initiatedByRole: 'chapter_president',
        decision: null, strikeNumber: null, founderReview: null,
        founderReviewRequests: { lastRequestAt: null, requestCount: 0 },
        statusHistory: [{ from: null, to: 'initiated', byUid: 'cp-1', byRole: 'chapter_president', at: NOW.toISOString() }],
        createdAt: NOW.toISOString(), noticeIssuedAt: null,
        ...overrides,
    });
}

describe('CONTRACT 4a: the front of the machine, step by step', () => {
    test('initiated -> notice_draft -> notice_issued -> defence_received -> hearing, each gate enforced', async () => {
        const db = seededDb();
        mockDb = db;
        const kase = await manualCase(db);
        expect(kase.status).toBe('initiated');

        const cp = await resolveActorOffices(db, 'cp-1');
        const ngs = await resolveActorOffices(db, 'ngs-1');
        const audit = await resolveActorOffices(db, 'audit-1');
        const subject = await resolveActorOffices(db, 'subject-1');

        // Skipping states is rejected.
        await expect(transitionCase(db, kase.caseId, 'hearing', audit, {}, NOW)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
        await expect(transitionCase(db, kase.caseId, 'defence_received', subject, { defenceText: 'x' }, NOW)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

        const drafted = await transitionCase(db, kase.caseId, 'notice_draft', cp, {}, NOW);
        expect(drafted.status).toBe('notice_draft');

        // Notice: NGS only; defence clock is exactly issue + 7 days.
        await expect(transitionCase(db, kase.caseId, 'notice_issued', cp, { noticeText: 'Notice' }, NOW)).rejects.toMatchObject({ code: 'NOTICE_NGS_ONLY' });
        const noticed = await transitionCase(db, kase.caseId, 'notice_issued', ngs, { noticeText: 'Formal notice text' }, NOW);
        expect(noticed.status).toBe('notice_issued');
        expect(noticed.defenceDueAt).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());

        // Defence: subject only.
        await expect(transitionCase(db, kase.caseId, 'defence_received', cp, { defenceText: 'Not mine' }, NOW)).rejects.toMatchObject({ code: 'DEFENCE_SUBJECT_ONLY' });
        const defended = await transitionCase(db, kase.caseId, 'defence_received', subject, { defenceText: 'My defence.' }, NOW);
        expect(defended.status).toBe('defence_received');
        expect(defended.defenceLate).toBe(false);

        // Hearing: Audit Chair only.
        await expect(transitionCase(db, kase.caseId, 'hearing', ngs, {}, NOW)).rejects.toMatchObject({ code: 'HEARING_AUDIT_CHAIR_ONLY' });
        const hearing = await transitionCase(db, kase.caseId, 'hearing', audit, {}, NOW);
        expect(hearing.status).toBe('hearing');
        expect(hearing.hearingOfficerUid).toBe('audit-1');
        expect((hearing.statusHistory || []).map((h: any) => h.to)).toEqual(['initiated', 'notice_draft', 'notice_issued', 'defence_received', 'hearing']);
    });

    test('decided and sanction_applied are INTERNAL: transitionCase refuses both with USE_DECISION_PATH', async () => {
        const db = seededDb();
        seedCaseAt(db, 'h-1', 'hearing');
        const audit = await resolveActorOffices(db, 'audit-1');
        await expect(transitionCase(db, 'h-1', 'decided', audit, {}, NOW)).rejects.toMatchObject({ code: 'USE_DECISION_PATH' });
        seedCaseAt(db, 'd-1', 'decided', { decision: 'strike1', strikeNumber: 1 });
        await expect(transitionCase(db, 'd-1', 'sanction_applied', audit, {}, NOW)).rejects.toMatchObject({ code: 'USE_DECISION_PATH' });
        expect((await getCase(db, 'h-1')).status).toBe('hearing');
    });

    test('system-only transitions refuse human actors; the system actor can close the defence window', async () => {
        const db = seededDb();
        seedCaseAt(db, 'n-1', 'notice_issued', { noticeIssuedAt: NOW.toISOString(), defenceDueAt: new Date(NOW.getTime() - DAY).toISOString() });
        const ngs = await resolveActorOffices(db, 'ngs-1');
        await expect(transitionCase(db, 'n-1', 'defence_window_closed', ngs, {}, NOW)).rejects.toMatchObject({ code: 'SYSTEM_ONLY' });
        const system = { uid: 'system', offices: [] as any[], roleKey: 'system', chapterId: null };
        const closedWindow = await transitionCase(db, 'n-1', 'defence_window_closed', system, { systemActor: true }, NOW);
        expect(closedWindow.status).toBe('defence_window_closed');
    });
});

describe('CONTRACT 4b: terminal states and dismissal', () => {
    test('closed and dismissed are terminal: every outgoing transition is CASE_TERMINAL', async () => {
        const db = seededDb();
        const cp = await resolveActorOffices(db, 'cp-1');
        seedCaseAt(db, 't-closed', 'closed');
        seedCaseAt(db, 't-dismissed', 'dismissed');
        await expect(transitionCase(db, 't-closed', 'dismissed', cp, { decisionReason: DISMISS_REASON }, NOW)).rejects.toMatchObject({ code: 'CASE_TERMINAL' });
        await expect(transitionCase(db, 't-dismissed', 'notice_draft', cp, {}, NOW)).rejects.toMatchObject({ code: 'CASE_TERMINAL' });
    });

    test('dismissal from hearing requires a >=30-char reason and stamps decision + closedAt', async () => {
        const db = seededDb();
        const cp = await resolveActorOffices(db, 'cp-1');
        seedCaseAt(db, 'h-2', 'hearing');
        await expect(transitionCase(db, 'h-2', 'dismissed', cp, { decisionReason: 'short' }, NOW)).rejects.toMatchObject({ code: 'DECISION_REASON_REQUIRED' });
        const dismissed = await transitionCase(db, 'h-2', 'dismissed', cp, { decisionReason: DISMISS_REASON }, NOW);
        expect(dismissed.status).toBe('dismissed');
        expect(dismissed.decision).toBe('dismissed');
        expect(dismissed.decisionReason).toBe(DISMISS_REASON);
        expect(dismissed.closedAt).toBe(NOW.toISOString());
    });

    test('stale referral drafts (>14 days, never noticed) auto-dismiss; fresh drafts survive', async () => {
        const db = seededDb();
        seedCaseAt(db, 'old-draft', 'notice_draft', { initiationSource: 'cron_referral', createdAt: new Date(NOW.getTime() - 15 * DAY).toISOString() });
        seedCaseAt(db, 'fresh-draft', 'notice_draft', { initiationSource: 'cron_referral', createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString() });
        const result = await expireStaleDrafts(db, NOW);
        expect(result).toEqual({ expired: 1, caseIds: ['old-draft'] });
        expect((await getCase(db, 'old-draft')).status).toBe('dismissed');
        expect((await getCase(db, 'fresh-draft')).status).toBe('notice_draft');
    });
});

describe('CONTRACT 4c: the Board tail (strike3 only)', () => {
    test('board_notice_issued is strike3-only, NGS-only, and sets the vote opening at +7 days', async () => {
        const db = seededDb();
        const ngs = await resolveActorOffices(db, 'ngs-1');
        const cp = await resolveActorOffices(db, 'cp-1');
        seedCaseAt(db, 's1-case', 'decided', { decision: 'strike1', strikeNumber: 1 });
        await expect(transitionCase(db, 's1-case', 'board_notice_issued', ngs, {}, NOW)).rejects.toMatchObject({ code: 'BOARD_NOTICE_STRIKE3_ONLY' });
        seedCaseAt(db, 's3-case', 'decided', { decision: 'strike3', strikeNumber: 3 });
        await expect(transitionCase(db, 's3-case', 'board_notice_issued', cp, {}, NOW)).rejects.toMatchObject({ code: 'NGS_ONLY' });
        const noticed = await transitionCase(db, 's3-case', 'board_notice_issued', ngs, {}, NOW);
        expect(noticed.status).toBe('board_notice_issued');
        expect(noticed.boardNoticeIssuedAt).toBe(NOW.toISOString());
        expect(noticed.boardVoteOpensAt).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    });

    test('board_vote_open: never before the 7-day notice period (409), never without a seated Board (409)', async () => {
        const db = seededDb();
        const ngs = await resolveActorOffices(db, 'ngs-1');
        seedCaseAt(db, 's3-case', 'board_notice_issued', {
            decision: 'strike3', strikeNumber: 3,
            boardVoteOpensAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
        });
        await expect(transitionCase(db, 's3-case', 'board_vote_open', ngs, {}, NOW)).rejects.toMatchObject({ code: 'BOARD_NOTICE_PERIOD', status: 409 });
        const later = new Date(NOW.getTime() + 8 * DAY);
        await expect(transitionCase(db, 's3-case', 'board_vote_open', ngs, {}, later)).rejects.toMatchObject({ code: 'BOARD_NOT_SEATED', status: 409 });
        for (const g of ['g1', 'g2', 'g3']) db.seed(`governors/${g}`, { vacant: false, status: 'seated' });
        db.seed('governors/g4', { vacant: true, status: 'vacant' });
        const opened = await transitionCase(db, 's3-case', 'board_vote_open', ngs, {}, later);
        expect(opened.status).toBe('board_vote_open');
    });
});

describe('CONTRACT 4d: founder review is a request, not an appeal state', () => {
    function req(body: any) {
        return new NextRequest('http://localhost/api/discipline/request-founder-review', {
            method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        });
    }
    test('subject request on a decided case: status unchanged, no appealStatus, count+stamp recorded, Founder tasked', async () => {
        const db = seededDb();
        mockDb = db;
        seedCaseAt(db, 'dec-1', 'closed', { decision: 'strike1', strikeNumber: 1 });
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        const res = await requestReviewPOST(req({ caseId: 'dec-1', statement: 'Please review new evidence.' }));
        expect(res.status).toBe(200);
        const kase = await getCase(db, 'dec-1');
        expect(kase.status).toBe('closed'); // the request moves nothing
        expect(kase.founderReviewRequests).toEqual({ lastRequestAt: expect.any(String), requestCount: 1 });
        expect(JSON.stringify(kase)).not.toContain('appealStatus');
        expect(kase.founderReview).toBeNull();
    });
    test('undecided case 400 CASE_NOT_DECIDED; non-subject 403; repeat within 30 days 429', async () => {
        const db = seededDb();
        mockDb = db;
        seedCaseAt(db, 'open-1', 'notice_issued', { noticeIssuedAt: NOW.toISOString() });
        seedCaseAt(db, 'dec-1', 'closed', { decision: 'strike1', strikeNumber: 1 });
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        expect((await requestReviewPOST(req({ caseId: 'open-1', statement: 'Too soon.' }))).status).toBe(400);
        mockAuth = { authenticated: true, user: { userId: 'intruder' } };
        expect((await requestReviewPOST(req({ caseId: 'dec-1', statement: 'Not mine.' }))).status).toBe(403);
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        expect((await requestReviewPOST(req({ caseId: 'dec-1', statement: 'First.' }))).status).toBe(200);
        expect((await requestReviewPOST(req({ caseId: 'dec-1', statement: 'Second.' }))).status).toBe(429);
    });
});
