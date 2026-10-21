/**
 * @jest-environment node
 *
 * Spec E.11 founder-review route tests: T41 (route level), T42.
 * Founder is gated by UID equality - a role holder who is not the
 * Founder UID gets 403.
 */
import { NextRequest } from 'next/server';

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

import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';
import { FOUNDER_UID } from '@/lib/roles';
import { POST } from '../route';

function req(body: any) {
    return new NextRequest('http://localhost/api/admin/founder-review', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
}

function authAs(uid: string) {
    return { authenticated: true, user: { userId: uid, email: 'x@example.com', role: 'member' } };
}

beforeEach(() => {
    mockDb = makeFakeDb();
    mockAuth = authAs(FOUNDER_UID);
});

describe('founder-review route', () => {
    test('non-Founder UID gets 403 even with a senior role', async () => {
        mockAuth = authAs('some-president-uid');
        const res = await POST(req({ caseId: 'c1', action: 'uphold', noticeText: 'n', reason: 'r' }));
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toBe('FOUNDER_ONLY');
    });

    test('missing noticeText is rejected for every action', async () => {
        mockDb.seed('disciplinary_cases/c1', { caseId: 'c1', subjectUid: 's1', status: 'closed', statusHistory: [] });
        const res = await POST(req({ caseId: 'c1', action: 'uphold', noticeText: '', reason: 'r' }));
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBe('NOTICE_TEXT_REQUIRED');
    });

    test('T41 route level: modify cannot increase a sanction', async () => {
        mockDb.seed('users/s1', { displayName: 'S', warningCount: 1 });
        mockDb.seed('settings/discipline', { shadowMode: false });
        mockDb.seed('disciplinary_cases/c1', {
            caseId: 'c1', caseNumber: 'DISC-2026-0001', subjectUid: 's1', status: 'closed',
            decision: 'strike1', strikeNumber: 1, founderReview: null, statusHistory: [],
            sanctionApplied: { warningRecordId: 'w1', suspensionDays: null, banVoteId: null },
        });
        const res = await POST(req({
            caseId: 'c1', action: 'modify', noticeText: 'Your sanction was reviewed.',
            reason: 'internal review', modifyPayload: { newStrike: 2, newSuspensionDays: 10 },
        }));
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBe('MODIFY_INCREASE_FORBIDDEN');
    });

    test('T42 reinstate restores role via the write path and clears board-ban flags', async () => {
        mockDb.seed('users/s1', {
            displayName: 'S', role: 'team_member', warningCount: 3,
            isBanned: true, bannedBy: 'board:v1', bannedReason: 'Expelled by Board vote - case DISC-2026-0009',
            bannedAt: '2026-10-01T00:00:00.000Z', isBlacklisted: true,
        });
        mockDb.seed('roles/s1', { role: 'team_member' });
        mockDb.seed('disciplinary_cases/c9', {
            caseId: 'c9', caseNumber: 'DISC-2026-0009', subjectUid: 's1', status: 'closed',
            decision: 'strike3', strikeNumber: 3, founderReview: null, statusHistory: [],
            subjectRoleSnapshot: 'chapter_president', boardVoteId: 'v1',
            sanctionApplied: { warningRecordId: null, suspensionDays: null, banVoteId: 'v1' },
        });
        const res = await POST(req({
            caseId: 'c9', action: 'reinstate',
            noticeText: 'The Founder has reinstated your membership.',
            reason: 'New evidence reviewed.',
        }));
        expect(res.status).toBe(200);
        const user = mockDb.read('users/s1');
        expect(user?.isBanned).toBe(false);
        expect(user?.isBlacklisted).toBe(false);
        expect(user?.bannedBy).toBeNull();
        expect(user?.role).toBe('chapter_president');
        expect(mockDb.read('roles/s1')?.role).toBe('chapter_president');
        const kase = mockDb.read('disciplinary_cases/c9');
        expect(kase?.founderReview?.outcome).toBe('reinstate');
        expect(kase?.reinstatementRoleRestore).toBe('restored');
    });

    test('uphold records the review and changes nothing on the user', async () => {
        mockDb.seed('users/s1', { displayName: 'S', warningCount: 1 });
        mockDb.seed('disciplinary_cases/c1', {
            caseId: 'c1', caseNumber: 'DISC-2026-0001', subjectUid: 's1', status: 'closed',
            decision: 'strike1', strikeNumber: 1, founderReview: null, statusHistory: [],
        });
        const res = await POST(req({
            caseId: 'c1', action: 'uphold',
            noticeText: 'The Founder reviewed your case and upheld the decision.',
            reason: 'Process was followed.',
        }));
        expect(res.status).toBe(200);
        expect(mockDb.read('users/s1')?.warningCount).toBe(1);
        expect(mockDb.read('disciplinary_cases/c1')?.founderReview?.outcome).toBe('upheld');
    });
});
