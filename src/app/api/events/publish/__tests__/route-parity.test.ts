/**
 * @jest-environment node
 *
 * Family B parity test for POST /api/events/publish (B18;
 * canManageEvents). This was a D-CLAIM site: the gate read the role
 * off the ID TOKEN (decoded.role) — §(e) rule 3 deletes the claim read
 * and resolves the holder from Firestore via
 * hasServerPermissionForUser(db, decoded.uid, key). The mocked token
 * below carries NO role claim at all, so any pass is Firestore-sourced.
 * No pre-existing suite covered this route.
 *
 * A holder whose PRIMARY role is `member` with the key granted via a
 * custom role in additionalRoles (contracts K2) is admitted; an expired
 * grant and a missing grant keep the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver runs against FakeFirestore.
 * Only firebase-admin (both the server module and the raw package the
 * route imports for auth) is mocked.
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      verifyIdToken: jest.fn(async () => ({ uid: HOLDER })),
    }),
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts' },
      Timestamp: { fromDate: (d: Date) => d },
    },
  },
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from '@/lib/server/__tests__/fake-firestore';
import { POST } from '../route';

function seedHolder(db: FakeDb, expired = false) {
  db.seed('roles', HOLDER, {
    role: 'member',
    additionalRoles: [CUSTOM],
    ...(expired
      ? { expiresAt: new Date(Date.now() - 60_000), expiresRoleKey: CUSTOM }
      : {}),
  });
  db.seed('roleDefinitions', CUSTOM, {
    isCustom: true,
    permissions: ['canManageEvents'],
  });
  db.seed('events', 'ev-1', { title: 'Launch Night', broadcasted: false });
}

function req() {
  return new NextRequest('http://localhost/api/events/publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ eventId: 'ev-1' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHolder.db = createFakeDb();
});

describe('B18 POST /api/events/publish parity (was token-claim gated)', () => {
  it('custom canManageEvents holder can publish (token carries no role claim)', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('no grant is denied unchanged', async () => {
    const db = mockDbHolder.db as FakeDb;
    db.seed('roles', HOLDER, { role: 'member' });
    db.seed('events', 'ev-1', { title: 'Launch Night', broadcasted: false });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
