/**
 * @jest-environment node
 *
 * Member visibility tests (spec E.6.3/E.8): drafts and un-noticed cases
 * are invisible to the subject; noticed cases show with member-safe
 * fields only. Plus the Founder-review request flow (E.5): subject
 * only, decided cases only, 30-day rate limit, no appealStatus writes.
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
import { FOUNDER_UID } from '@/lib/roles';
import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';
import { GET } from '../route';
import { POST } from '../../request-founder-review/route';

function seed() {
    const db = makeFakeDb();
    db.seed('users/subject-1', { displayName: 'Subject' });
    const base = { subjectUid: 'subject-1', founderReviewRequests: { lastRequestAt: null, requestCount: 0 }, statusHistory: [] };
    db.seed('disciplinary_cases/draft-1', { ...base, caseId: 'draft-1', caseNumber: 'DISC-2026-0001', status: 'notice_draft', initiationSource: 'cron_referral' });
    db.seed('disciplinary_cases/init-1', { ...base, caseId: 'init-1', caseNumber: 'DISC-2026-0002', status: 'initiated' });
    db.seed('disciplinary_cases/noticed-1', {
        ...base, caseId: 'noticed-1', caseNumber: 'DISC-2026-0003', status: 'notice_issued',
        noticeIssuedAt: '2026-10-10T00:00:00.000Z', hearingNotes: 'INTERNAL', drafterNote: 'INTERNAL',
    });
    db.seed('disciplinary_cases/decided-1', {
        ...base, caseId: 'decided-1', caseNumber: 'DISC-2026-0004', status: 'closed',
        decision: 'strike1', strikeNumber: 1, noticeIssuedAt: '2026-10-01T00:00:00.000Z',
    });
    return db;
}

describe('my-cases visibility', () => {
    test('drafts and un-noticed cases are invisible to the subject', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        const res = await GET(new NextRequest('http://localhost/api/discipline/my-cases'));
        expect(res.status).toBe(200);
        const json = await res.json();
        const numbers = json.cases.map((c: any) => c.caseNumber).sort();
        expect(numbers).toEqual(['DISC-2026-0003', 'DISC-2026-0004']);
        const raw = JSON.stringify(json);
        expect(raw).not.toContain('INTERNAL');
        expect(raw).not.toContain('hearingNotes');
    });
});

describe('request-founder-review', () => {
    function req(body: any) {
        return new NextRequest('http://localhost/api/discipline/request-founder-review', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
        });
    }

    test('subject can request; a Founder task is created; no appealStatus anywhere', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        const res = await POST(req({ caseId: 'decided-1', statement: 'New evidence exists.' }));
        expect(res.status).toBe(200);
        const tasks = mockDb.readCollection('tasks');
        expect(tasks.some((t: any) => Array.isArray(t.data.assigneeIds) && t.data.assigneeIds.includes(FOUNDER_UID))).toBe(true);
        const kase = mockDb.read('disciplinary_cases/decided-1');
        expect(kase?.founderReviewRequests?.requestCount).toBe(1);
        expect(JSON.stringify(kase)).not.toContain('appealStatus');
        expect(JSON.stringify(tasks)).not.toContain('appealStatus');
    });

    test('a second request within 30 days is rate-limited', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        await POST(req({ caseId: 'decided-1', statement: 'First.' }));
        const res = await POST(req({ caseId: 'decided-1', statement: 'Second.' }));
        expect(res.status).toBe(429);
    });

    test('non-subject gets 403; undecided case gets 400', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 'someone-else' } };
        const res = await POST(req({ caseId: 'decided-1', statement: 'Not mine.' }));
        expect(res.status).toBe(403);
        mockAuth = { authenticated: true, user: { userId: 'subject-1' } };
        const res2 = await POST(req({ caseId: 'noticed-1', statement: 'Too early.' }));
        expect(res2.status).toBe(400);
    });
});
