/**
 * @jest-environment node
 *
 * Discipline settings API tests. The route is the only admin surface
 * for settings/discipline: GET serves the effective settings (with
 * fail-safe defaults), PUT validates and merges a full settings body.
 * Gates: read needs canAccessAdmin, write needs canManageUsers (the
 * gate the retired warning-settings page used).
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
import { GET, PUT } from '../route';

function authAs(role: string, uid = 'admin-1') {
    return { authenticated: true, user: { userId: uid, email: 'a@example.com', role } };
}

function seed() {
    const db = makeFakeDb();
    // A member role with an explicit, empty grant set: both gates deny.
    db.seed('roleDefinitions/member', { permissions: [] });
    return db;
}

function putReq(body: unknown) {
    return new NextRequest('http://localhost/api/admin/discipline-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

const VALID = {
    shadowMode: false,
    cronReferralLive: true,
    referralWindowDays: 14,
    referralMissThreshold: 2,
    warningRegistryVariant: 'internal',
};

describe('GET /api/admin/discipline-settings', () => {
    beforeEach(() => {
        mockDb = seed();
        mockAuth = authAs('superadmin');
    });

    it('rejects unauthenticated callers', async () => {
        mockAuth = { authenticated: false, user: null };
        const res = await GET(new NextRequest('http://localhost/api/admin/discipline-settings'));
        expect(res.status).toBe(401);
    });

    it('forbids roles without canAccessAdmin', async () => {
        mockAuth = authAs('member');
        const res = await GET(new NextRequest('http://localhost/api/admin/discipline-settings'));
        expect(res.status).toBe(403);
    });

    it('returns the fail-safe defaults when no settings doc exists', async () => {
        const res = await GET(new NextRequest('http://localhost/api/admin/discipline-settings'));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.settings).toEqual({
            shadowMode: true,
            cronReferralLive: false,
            referralWindowDays: 28,
            referralMissThreshold: 3,
            warningRegistryVariant: 'retired',
        });
    });

    it('returns stored settings when the doc exists', async () => {
        mockDb.seed('settings/discipline', { ...VALID });
        const res = await GET(new NextRequest('http://localhost/api/admin/discipline-settings'));
        const data = await res.json();
        expect(data.settings).toEqual(VALID);
    });
});

describe('PUT /api/admin/discipline-settings', () => {
    beforeEach(() => {
        mockDb = seed();
        mockAuth = authAs('superadmin');
    });

    it('forbids roles without canManageUsers', async () => {
        mockAuth = authAs('member');
        const res = await PUT(putReq(VALID));
        expect(res.status).toBe(403);
    });

    it('writes a valid body to settings/discipline', async () => {
        const res = await PUT(putReq(VALID));
        expect(res.status).toBe(200);
        const snap = await mockDb.collection('settings').doc('discipline').get();
        expect(snap.exists).toBe(true);
        const stored = snap.data();
        expect(stored.shadowMode).toBe(false);
        expect(stored.cronReferralLive).toBe(true);
        expect(stored.warningRegistryVariant).toBe('internal');
        expect(stored.updatedBy).toBe('admin-1');
    });

    it('rejects an unknown registry variant', async () => {
        const res = await PUT(putReq({ ...VALID, warningRegistryVariant: 'public' }));
        expect(res.status).toBe(400);
    });

    it('rejects an out-of-range referral window', async () => {
        const res = await PUT(putReq({ ...VALID, referralWindowDays: 0 }));
        expect(res.status).toBe(400);
    });

    it('rejects a non-boolean switch', async () => {
        const res = await PUT(putReq({ ...VALID, shadowMode: 'off' }));
        expect(res.status).toBe(400);
    });
});
