/**
 * @jest-environment node
 *
 * Route-level mirror wiring for PUT /api/admin/discipline-settings:
 * the mirror fires after the primary Firestore write succeeds, with the
 * exact written payload, and a mirror failure leaves the response
 * unchanged (failure invisible).
 */
let mockDb: any;
let mockAuth: any;
const mockMirror = jest.fn(async () => true);
// W4 primacy double, OFF-faithful: with SUPA_PRIMARY unset the real
// setSettingsDocPrimaryFirst returns false with no side effects, and
// the route runs its original Firestore-first flow + mirror. The
// primacy-ON arm is pinned by settings-notifications-primacy-w4.
const mockPrimaryFirst = jest.fn(async () => false);
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
jest.mock('@/lib/server/settings-mirror', () => ({
    mirrorSettingsDoc: (...args: any[]) => (mockMirror as any)(...args),
    setSettingsDocPrimaryFirst: (...args: any[]) => (mockPrimaryFirst as any)(...args),
}));

import { NextRequest } from 'next/server';
import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';
import { PUT } from '../route';

const VALID = {
    shadowMode: false,
    cronReferralLive: true,
    referralWindowDays: 14,
    referralMissThreshold: 2,
    warningRegistryVariant: 'internal',
};

function putReq(body: unknown) {
    return new NextRequest('http://localhost/api/admin/discipline-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

beforeEach(() => {
    mockMirror.mockReset();
    mockMirror.mockResolvedValue(true);
    mockPrimaryFirst.mockReset();
    mockPrimaryFirst.mockResolvedValue(false);
    mockDb = makeFakeDb();
    mockDb.seed('roleDefinitions/member', { permissions: [] });
    mockDb.seed('roles/admin-1', { role: 'superadmin' });
    mockAuth = {
        authenticated: true,
        user: { userId: 'admin-1', email: 'a@example.com', role: 'superadmin' },
    };
});

describe('PUT mirror wiring', () => {
    it('mirrors the exact written payload after primary success', async () => {
        const res = await PUT(putReq(VALID));
        expect(res.status).toBe(200);
        const snap = await mockDb.collection('settings').doc('discipline').get();
        const stored = snap.data();
        // The route consults the primacy helper first (OFF double:
        // returns false), with the identical payload it then writes
        // to Firestore and mirrors.
        expect(mockPrimaryFirst).toHaveBeenCalledTimes(1);
        expect(mockPrimaryFirst).toHaveBeenCalledWith('settings', 'discipline', stored);
        expect(mockMirror).toHaveBeenCalledTimes(1);
        expect(mockMirror).toHaveBeenCalledWith('settings', 'discipline', stored);
        const mirrored = (mockMirror.mock.calls[0] as unknown as [string, string, unknown])[2] as any;
        expect(mirrored.updatedAt).toBe(stored.updatedAt); // same ISO string
        expect(mirrored.updatedBy).toBe('admin-1');
    });

    it('a throwing mirror leaves the response unchanged', async () => {
        mockMirror.mockRejectedValue(new Error('supa down'));
        const res = await PUT(putReq(VALID));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({
            success: true,
            settings: VALID,
            defaults: {
                shadowMode: true,
                cronReferralLive: false,
                referralWindowDays: 28,
                referralMissThreshold: 3,
                warningRegistryVariant: 'retired',
            },
        });
    });

    it('does not mirror when validation fails', async () => {
        const res = await PUT(putReq({ ...VALID, referralWindowDays: 0 }));
        expect(res.status).toBe(400);
        expect(mockPrimaryFirst).not.toHaveBeenCalled();
        expect(mockMirror).not.toHaveBeenCalled();
    });
});
