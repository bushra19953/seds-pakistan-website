/**
 * @jest-environment node
 *
 * Spec E.11 suspension tests: T21, T22, T23.
 * T21/T23 are exercised at the guard level: the wired routes (tasks
 * PATCH, tasks acceptance, workflows PATCH, delegate POST, event
 * registrations POST) all delegate to these exact helpers
 * (suspensionBlock / findBannedDelegateTarget), so the guard behaviour
 * IS the route behaviour for the suspension decision.
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

import { Timestamp } from 'firebase-admin/firestore';
import { makeFakeDb } from './fake-firestore';
import {
    assertNotSuspended,
    findBannedDelegateTarget,
    getSuspensionState,
    suspensionBlock,
} from '../suspension';
import { runSuspensionLifts } from '../stanzas';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
const PAST = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);

describe('suspension enforcement (T21-T23)', () => {
    test('T21 assertNotSuspended blocks a suspended member; expired suspension passes', async () => {
        const suspended = { privilegesSuspendedUntil: Timestamp.fromDate(FUTURE), suspensionCaseId: 'case-1' };
        expect(() => assertNotSuspended(suspended, NOW)).toThrowError(expect.objectContaining({ code: 'SUSPENDED' }));
        const expired = { privilegesSuspendedUntil: Timestamp.fromDate(PAST), suspensionCaseId: 'case-1' };
        expect(() => assertNotSuspended(expired, NOW)).not.toThrow();
        expect(() => assertNotSuspended({}, NOW)).not.toThrow();
        expect(() => assertNotSuspended(null, NOW)).not.toThrow();

        const db = makeFakeDb();
        db.seed('users/u-susp', { privilegesSuspendedUntil: Timestamp.fromDate(FUTURE), suspensionCaseId: 'case-9' });
        const block = await suspensionBlock(db, 'u-susp', NOW);
        expect(block?.error).toBe('SUSPENDED');
        expect(block?.caseId).toBe('case-9');
        const state = await getSuspensionState(db, 'u-susp', NOW);
        expect(state.suspended).toBe(true);
        // Login-path analogue: the state reader never throws, so reads
        // (login, profile, defence) are never blocked by this module.
        await expect(getSuspensionState(db, 'nobody', NOW)).resolves.toEqual({ suspended: false, until: null, caseId: null });
    });

    test('T22 suspension lift clears the fields and writes the audit entry', async () => {
        const db = makeFakeDb();
        db.seed('users/u-lift', {
            displayName: 'Lifted',
            privilegesSuspendedUntil: Timestamp.fromDate(PAST),
            suspendedFrom: Timestamp.fromDate(new Date(PAST.getTime() - 14 * 24 * 60 * 60 * 1000)),
            suspensionCaseId: 'case-lift',
        });
        db.seed('users/u-still', {
            displayName: 'Still Suspended',
            privilegesSuspendedUntil: Timestamp.fromDate(FUTURE),
            suspensionCaseId: 'case-still',
        });
        const result = await runSuspensionLifts(db, NOW);
        expect(result.lifted).toBe(1);
        expect(result.uids).toEqual(['u-lift']);
        const lifted = db.read('users/u-lift');
        expect(lifted?.privilegesSuspendedUntil).toBeNull();
        expect(lifted?.suspendedFrom).toBeNull();
        expect(lifted?.suspensionCaseId).toBeNull();
        const still = db.read('users/u-still');
        expect(still?.suspensionCaseId).toBe('case-still');
        const audits = db.readCollection('audit_logs');
        expect(audits.some((a) => a.data.action === 'suspension_lifted' && a.data.targetId === 'u-lift')).toBe(true);
    });

    test('T23 delegate guard: suspended actor blocked, banned target rejected', async () => {
        const db = makeFakeDb();
        db.seed('users/actor-1', { privilegesSuspendedUntil: Timestamp.fromDate(FUTURE), suspensionCaseId: 'case-1' });
        db.seed('users/target-ok', { isBanned: false });
        db.seed('users/target-banned', { isBanned: true });
        // The delegate route calls exactly these two guards in order.
        expect(await suspensionBlock(db, 'actor-1', NOW)).not.toBeNull();
        expect(await findBannedDelegateTarget(db, ['target-ok'])).toBeNull();
        expect(await findBannedDelegateTarget(db, ['target-ok', 'target-banned'])).toBe('target-banned');
    });
});
