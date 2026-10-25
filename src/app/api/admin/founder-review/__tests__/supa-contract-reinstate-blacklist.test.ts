/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 3
 * (behavioural half; the textual sole-writer pin is T-GREP-1 in
 * src/lib/server/discipline/__tests__/grep-invariant.test.ts).
 *
 * Invariant 3 (isBlacklisted NEVER AUTO-CLEARS): no cron, lifecycle
 * or probation path writes isBlacklisted (see the clear-probation and
 * probation contract suites). The ONLY writer in src/** is Founder
 * reinstatement in src/app/api/admin/founder-review/route.ts, and
 * the code there is narrower than a blanket "reinstatement clears
 * the flag":
 *  - reinstate writes isBlacklisted=false ONLY when the ban being
 *    undone was a board ban (route.ts:165-177: wasBoardBan =
 *    bannedBy starts with 'board:');
 *  - reinstate of a NON-board (e.g. legacy threshold) ban clears
 *    isBanned and refunds deducted points but leaves a legacy
 *    isBlacklisted=true flag IN PLACE;
 *  - revoke_sanction clears isBanned only when this case's board
 *    vote set it, and never touches isBlacklisted;
 *  - applyReviewModification (founder modify) clears isBanned on a
 *    strike-3 reduction and never touches isBlacklisted.
 * These tests pin that exact current behaviour.
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
import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';
import { FOUNDER_UID } from '@/lib/roles';
import { applyReviewModification } from '@/lib/server/discipline/apply-decision';
import { POST } from '../route';

function req(body: any) {
    return new NextRequest('http://localhost/api/admin/founder-review', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
}

function seedCase(db: any, overrides: Record<string, any> = {}) {
    db.seed('disciplinary_cases/c9', {
        caseId: 'c9', caseNumber: 'DISC-2026-0009', subjectUid: 's1', status: 'closed',
        decision: 'strike3', strikeNumber: 3, founderReview: null, statusHistory: [],
        subjectRoleSnapshot: null, boardVoteId: 'v1',
        sanctionApplied: { warningRecordId: null, suspensionDays: null, banVoteId: 'v1' },
        ...overrides,
    });
}

beforeEach(() => {
    mockDb = makeFakeDb();
    mockAuth = { authenticated: true, user: { userId: FOUNDER_UID, email: 'f@example.com', role: 'founder_patron' } };
});

describe('CONTRACT 3: isBlacklisted clears only via Founder reinstatement of a board ban', () => {
    test('reinstate of a board ban: isBlacklisted=false, isBanned=false, ban fields nulled', async () => {
        mockDb.seed('users/s1', {
            displayName: 'S', warningCount: 3, isBanned: true, bannedBy: 'board:v1',
            bannedReason: 'Expelled by Board vote - case DISC-2026-0009', bannedAt: '2026-10-01T00:00:00.000Z',
            isBlacklisted: true,
        });
        seedCase(mockDb);
        const res = await POST(req({ caseId: 'c9', action: 'reinstate', noticeText: 'Reinstated by the Founder.', reason: 'Review grounds.' }));
        expect(res.status).toBe(200);
        const user = mockDb.read('users/s1');
        expect(user?.isBlacklisted).toBe(false);
        expect(user?.isBanned).toBe(false);
        expect(user?.bannedReason).toBe('');
        expect(user?.bannedAt).toBeNull();
        expect(user?.bannedBy).toBeNull();
    });

    test('FINDING-PIN: reinstate of a NON-board (legacy) ban does NOT clear isBlacklisted', async () => {
        // route.ts:178-196: the non-board branch refunds points only.
        mockDb.seed('users/s1', {
            displayName: 'S', warningCount: 1, points: 100, isBanned: true, bannedBy: 'threshold-legacy',
            bannedReason: 'Reached 3 warnings. Blacklisted and banned permanently.', bannedAt: '2026-09-01T00:00:00.000Z',
            isBlacklisted: true,
        });
        mockDb.seed('users/s1/warnings/w1', { pointsDeducted: 5 });
        seedCase(mockDb, { boardVoteId: null, sanctionApplied: { warningRecordId: null, suspensionDays: null, banVoteId: null } });
        const res = await POST(req({ caseId: 'c9', action: 'reinstate', noticeText: 'Reinstated by the Founder.', reason: 'Review grounds.' }));
        expect(res.status).toBe(200);
        const user = mockDb.read('users/s1');
        expect(user?.isBanned).toBe(false);
        expect(user?.points).toBe(105); // legacy points refund happened
        expect(user?.isBlacklisted).toBe(true); // ...but the legacy flag survives even Founder reinstatement
    });

    test('revoke_sanction clears this case\'s board ban but never touches isBlacklisted', async () => {
        mockDb.seed('users/s1', {
            displayName: 'S', warningCount: 3, isBanned: true, bannedBy: 'board:v1',
            bannedReason: 'Expelled by Board vote - case DISC-2026-0009', isBlacklisted: true,
            privilegesSuspendedUntil: 'x', suspendedFrom: 'y', suspensionCaseId: 'c9',
        });
        seedCase(mockDb);
        const res = await POST(req({ caseId: 'c9', action: 'revoke_sanction', noticeText: 'Sanction revoked.', reason: 'Review grounds.' }));
        expect(res.status).toBe(200);
        const user = mockDb.read('users/s1');
        expect(user?.isBanned).toBe(false);
        expect(user?.isBlacklisted).toBe(true);
        expect(user?.privilegesSuspendedUntil).toBeNull();
    });

    test('uphold changes nothing on the user, including isBlacklisted', async () => {
        mockDb.seed('users/s1', { displayName: 'S', warningCount: 3, isBanned: true, isBlacklisted: true });
        seedCase(mockDb);
        const res = await POST(req({ caseId: 'c9', action: 'uphold', noticeText: 'Decision upheld.', reason: 'Process followed.' }));
        expect(res.status).toBe(200);
        const user = mockDb.read('users/s1');
        expect(user?.isBlacklisted).toBe(true);
        expect(user?.isBanned).toBe(true);
    });

    test('a non-Founder cannot reinstate at all (403 FOUNDER_ONLY, no writes)', async () => {
        mockAuth = { authenticated: true, user: { userId: 'some-president', email: 'p@example.com', role: 'president_national' } };
        mockDb.seed('users/s1', { displayName: 'S', isBanned: true, bannedBy: 'board:v1', isBlacklisted: true });
        seedCase(mockDb);
        const res = await POST(req({ caseId: 'c9', action: 'reinstate', noticeText: 'Reinstated.', reason: 'Review grounds.' }));
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('FOUNDER_ONLY');
        expect(mockDb.read('users/s1')?.isBlacklisted).toBe(true);
    });

    test('founder MODIFY (strike3 -> strike2) clears isBanned but leaves isBlacklisted untouched', async () => {
        mockDb.seed('settings/discipline', { shadowMode: false });
        mockDb.seed('users/s1', {
            displayName: 'S', warningCount: 3, isBanned: true, bannedBy: 'board:v1',
            bannedReason: 'Expelled by Board vote - case DISC-2026-0009', isBlacklisted: true,
        });
        seedCase(mockDb);
        const founderActor = { uid: FOUNDER_UID, offices: ['founder'] as any[], roleKey: 'founder', chapterId: null };
        await applyReviewModification(mockDb, 'c9', { newStrike: 2, newSuspensionDays: 10 }, founderActor, new Date('2026-10-22T00:00:00.000Z'));
        const user = mockDb.read('users/s1');
        expect(user?.isBanned).toBe(false);
        expect(user?.isBlacklisted).toBe(true);
    });
});
