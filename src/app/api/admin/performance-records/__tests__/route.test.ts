/**
 * @jest-environment node
 *
 * Variant I performance-records API tests (spec E.7, T38).
 * Content rules asserted at the serializer level: decided cases only,
 * case number + tier + date only - no grounds, no narratives, and none
 * of the user-doc disciplinary flags (the E.7 forbidden-keys list:
 * warningCount, isBlacklisted, isBanned, isOnProbation,
 * privilegesSuspendedUntil) anywhere in the payload.
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
import { GET } from '../route';

const FORBIDDEN_KEYS = ['warningCount', 'isBlacklisted', 'isBanned', 'isOnProbation', 'privilegesSuspendedUntil', 'groundNarrative', 'constitutionalGround', 'decisionReason'];

function seed() {
    const db = makeFakeDb();
    db.seed('settings/discipline', { warningRegistryVariant: 'internal' });
    db.seed('roles/ngs-1', { role: 'national_general_secretary' });
    db.seed('roles/cp-1', { role: 'chapter_president' });
    db.seed('users/ngs-1', { displayName: 'NGS', role: 'national_general_secretary' });
    db.seed('users/cp-1', { displayName: 'CP', role: 'chapter_president', chapterId: 'ch-a' });
    db.seed('users/s-a', { displayName: 'Member A', chapterId: 'ch-a', warningCount: 9, isBanned: true });
    db.seed('users/s-b', { displayName: 'Member B', chapterId: 'ch-b', warningCount: 9, isBanned: true });
    db.seed('disciplinary_cases/c1', {
        caseId: 'c1', caseNumber: 'DISC-2026-0001', subjectUid: 's-a', status: 'closed',
        decision: 'strike1', strikeNumber: 1, decidedAt: '2026-10-01T00:00:00.000Z',
        constitutionalGround: '10.9(a)', groundNarrative: 'SECRET NARRATIVE TEXT', decisionReason: 'SECRET REASON',
    });
    db.seed('disciplinary_cases/c2', {
        caseId: 'c2', caseNumber: 'DISC-2026-0002', subjectUid: 's-b', status: 'closed',
        decision: 'strike2', strikeNumber: 2, decidedAt: '2026-10-02T00:00:00.000Z',
    });
    db.seed('disciplinary_cases/c3', {
        caseId: 'c3', caseNumber: 'DISC-2026-0003', subjectUid: 's-a', status: 'closed',
        decision: 'dismissed', strikeNumber: null, decidedAt: '2026-10-03T00:00:00.000Z',
    });
    db.seed('deadline_miss_records/m1', { subjectUid: 's-a', status: 'recorded' });
    return db;
}

describe('performance-records (Variant I)', () => {
    test('404 when the variant is not internal (Variant R default)', async () => {
        const db = seed();
        db.seed('settings/discipline', { warningRegistryVariant: 'retired' });
        mockDb = db;
        mockAuth = { authenticated: true, user: { userId: 'ngs-1' } };
        const res = await GET(new NextRequest('http://localhost/api/admin/performance-records'));
        expect(res.status).toBe(404);
    });

    test('T38 decided cases only, no forbidden keys, no narratives', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 'ngs-1' } };
        const res = await GET(new NextRequest('http://localhost/api/admin/performance-records'));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.records).toHaveLength(2); // dismissed case excluded
        expect(json.records[0].tier).toBe('Strike 2 (suspension)');
        expect(json.records[1].tier).toBe('formal warning (Strike 1)');
        expect(json.missCounts['s-a']).toBe(1);
        const raw = JSON.stringify(json);
        for (const key of FORBIDDEN_KEYS) {
            expect(raw).not.toContain(key);
        }
        expect(raw).not.toContain('SECRET NARRATIVE TEXT');
        expect(raw).not.toContain('SECRET REASON');
    });

    test('chapter president sees only own-chapter records (server filter)', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 'cp-1' } };
        const res = await GET(new NextRequest('http://localhost/api/admin/performance-records'));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.records).toHaveLength(1);
        expect(json.records[0].subjectUid).toBe('s-a');
    });

    test('a plain member gets 403', async () => {
        mockDb = seed();
        mockAuth = { authenticated: true, user: { userId: 's-a' } };
        const res = await GET(new NextRequest('http://localhost/api/admin/performance-records'));
        expect(res.status).toBe(403);
    });
});
