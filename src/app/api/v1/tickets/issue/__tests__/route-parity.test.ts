/**
 * @jest-environment node
 *
 * Parity tests for POST /api/v1/tickets/issue (Family F, F15).
 *
 * The gate used to read the caller's role from a users/{uid} snapshot
 * (callerSnap.data()?.role) feeding hasServerPermission; the snapshot read
 * existed solely for the gate and is gone. The gate now calls
 * hasServerPermissionForUser(db, callerUid, 'canManageEvents').
 * These tests run the REAL permissions module over an in-memory Firestore.
 *
 * Canonical holder fixture: primary `member` + additionalRoles
 * ['custom_verify_design_aide'] + roleDefinitions/custom_verify_design_aide
 * { isCustom: true, permissions: ['canManageEvents'] }.
 *
 * For the admitted case the request stops at the NEXT handler decision
 * (404 'Event not found' for an unseeded event), which is only reachable
 * past the gate.
 */

import { NextRequest } from 'next/server';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const mockHolder: { db: FakeFirestore | null } = { db: null };
const mockState = { uid: 'holder-1' };

const adminStub = {
  auth: () => ({
    verifyIdToken: async () => ({ uid: mockState.uid }),
  }),
  firestore: {
    Timestamp: {
      now: () => new Date(),
      fromDate: (d: Date) => d,
    },
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    },
  },
};

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: adminStub,
  ...adminStub,
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockHolder.db,
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async () => undefined),
    broadcastByRoles: jest.fn(async () => undefined),
  },
}));

import { POST } from '@/app/api/v1/tickets/issue/route';

const CUSTOM = 'custom_verify_design_aide';
const KEY = 'canManageEvents';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/v1/tickets/issue', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let db: FakeFirestore;

beforeEach(() => {
  db = createFakeFirestore() as never;
  mockHolder.db = db;
  mockState.uid = 'holder-1';

  db.__seed('roleDefinitions', CUSTOM, { isCustom: true, permissions: [KEY] });
  db.__seed('roles', 'holder-1', { role: 'member', additionalRoles: [CUSTOM] });
  db.__seed('roles', 'expired-1', {
    role: 'member',
    additionalRoles: [CUSTOM],
    expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresRoleKey: CUSTOM,
  });
  db.__seed('roles', 'plain-1', { role: 'member' });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.warn as jest.Mock).mockRestore?.();
});

describe('tickets issue parity (F15)', () => {
  it('custom holder passes the gate (reaches the event check: 404, not 403)', async () => {
    const res = await POST(req({ eventId: 'evt-missing', uid: 'target-1' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });

  it('expired custom grant is denied with the original 403 body', async () => {
    mockState.uid = 'expired-1';
    const res = await POST(req({ eventId: 'evt-missing', uid: 'target-1' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('caller with no grant is denied with the original 403 body', async () => {
    mockState.uid = 'plain-1';
    const res = await POST(req({ eventId: 'evt-missing', uid: 'target-1' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
