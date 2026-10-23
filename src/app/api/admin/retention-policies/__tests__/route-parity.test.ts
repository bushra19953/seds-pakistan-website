/**
 * @jest-environment node
 *
 * Family B parity tests for /api/admin/retention-policies (B15;
 * canViewAuditLogs, enforced by the file-local authorize() helper for
 * both GET and PUT). No pre-existing suite covered this route.
 *
 * A holder whose PRIMARY role is `member` with the key granted via a
 * custom role in additionalRoles (contracts K2) is admitted; an expired
 * grant and a missing grant keep the original 403 body.
 *
 * The REAL @/lib/server/permissions resolver and the REAL retention
 * policies module run against FakeFirestore. Only auth and
 * firebase-admin are mocked. Auth mocks use the real shape (userId,
 * NOT uid; nested token at user.user).
 */

const HOLDER = 'holder-1';
const CUSTOM = 'custom_verify_design_aide';

const state = {
  authResult: null as any,
};

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
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
import { GET, PUT } from '../route';

function authFor(uid: string) {
  return {
    authenticated: true,
    user: {
      user: { uid },
      userId: uid,
      email: 'holder@example.test',
      displayName: 'Holder One',
      emailVerified: true,
      role: 'member',
    },
  };
}

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
    permissions: ['canViewAuditLogs'],
  });
}

/** FakeDb has no collection.add(); the PUT handler writes an audit log. */
function withAdd(db: FakeDb): FakeDb {
  const orig = db.collection.bind(db);
  (db as any).collection = (name: string) => {
    const col: any = orig(name);
    if (!col.add) {
      col.add = async (data: Record<string, unknown>) => {
        const ref = col.doc();
        await ref.set(data);
        return ref;
      };
    }
    return col;
  };
  return db;
}

beforeEach(() => {
  jest.clearAllMocks();
  state.authResult = authFor(HOLDER);
  mockDbHolder.db = withAdd(createFakeDb());
});

describe('B15 /api/admin/retention-policies parity', () => {
  it('GET: custom canViewAuditLogs holder can read policies', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await GET(new NextRequest('http://localhost/api/admin/retention-policies'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.policies)).toBe(true);
    expect(body.policies.length).toBeGreaterThan(0);
  });

  it('GET: expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await GET(new NextRequest('http://localhost/api/admin/retention-policies'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('GET: no grant is denied unchanged', async () => {
    (mockDbHolder.db as FakeDb).seed('roles', HOLDER, { role: 'member' });
    const res = await GET(new NextRequest('http://localhost/api/admin/retention-policies'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('PUT: custom holder can save a policy (same authorize() gate)', async () => {
    seedHolder(mockDbHolder.db as FakeDb);
    const res = await PUT(
      new NextRequest('http://localhost/api/admin/retention-policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'warnings', archiveAfterDays: 100 }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).policy.key).toBe('warnings');
  });

  it('PUT: expired grant is denied with the original 403 body', async () => {
    seedHolder(mockDbHolder.db as FakeDb, true);
    const res = await PUT(
      new NextRequest('http://localhost/api/admin/retention-policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'warnings', archiveAfterDays: 100 }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});
