/**
 * @jest-environment node
 *
 * FIXED (adoption wave, pack 27 / GOV-02, Option B — the permission key):
 * POST /api/organizations now gates creation on
 * hasServerPermissionForUser(db, uid, 'canManageOrganizations') for
 * non-founders, NOT on rank (the old isSuperAdmin rank gate fed by the
 * 1-arg deny-all resolver is gone). The Founder keeps access via the
 * founder bypass and never goes through the permission lookup.
 *
 * The permission check is mocked KEY-AWARE (mockState.held): a caller
 * passes only when the route asks for a key they hold, so each case
 * also pins the exact key. Session and db seams are stubbed; the db
 * stub records created organizations through its add() mock.
 */

const mockState: { held: Set<string> } = { held: new Set() };

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: (req: { headers: { get(name: string): string | null } }) => {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  },
  verifyIdTokenString: jest.fn(async (token: string) => ({ uid: token })),
}));

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({
      doc: () => ({ set: jest.fn(async () => undefined) }),
      add: jest.fn(async () => ({ id: 'org-1' })),
    }),
  }),
  admin: {},
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(
    async (_db: unknown, _uid: string, key: string) => mockState.held.has(key),
  ),
  resolveUserRole: jest.fn(async () => null),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/organizations/route';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { FOUNDER_UID } from '@/lib/roles';

const mockPerm = hasServerPermissionForUser as jest.Mock;

function req(uid: string, body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/organizations', {
    method: 'POST',
    headers: { authorization: `Bearer ${uid}` },
    body: JSON.stringify(body),
  });
}

function as(held: string[] = []) {
  mockState.held = new Set(held);
}

beforeEach(() => {
  jest.clearAllMocks();
  as([]);
});

describe('FIXED (Option B): organizations POST gates on canManageOrganizations', () => {
  it('a canManageOrganizations holder can create an organization (200, org id returned)', async () => {
    as(['canManageOrganizations']);
    const res = await POST(req('holder-1', { name: 'Org', logoUrl: 'https://x/logo.png' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('org-1');
    expect(body.name).toBe('Org');
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'holder-1', 'canManageOrganizations');
  });

  it('a non-holder cannot create: 403 Forbidden, even with other keys held', async () => {
    as(['canManageSponsorsPartners', 'canViewGovernance']);
    const res = await POST(req('member-1', { name: 'Org', logoUrl: 'https://x/logo.png' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
    expect(mockPerm).toHaveBeenCalledWith(expect.anything(), 'member-1', 'canManageOrganizations');
  });

  it('rank alone no longer suffices: a caller with NO key held gets 403 (no isSuperAdmin gate)', async () => {
    as([]);
    const res = await POST(req('rank-only-holder', { name: 'Org', logoUrl: 'https://x/logo.png' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('the Founder keeps access with NO permission lookup and reaches body validation: 400, not 403', async () => {
    as([]);
    const res = await POST(req(FOUNDER_UID, {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Name and logo URL are required');
    expect(mockPerm).not.toHaveBeenCalled();
  });

  it('the Founder can create an organization (200)', async () => {
    as([]);
    const res = await POST(req(FOUNDER_UID, { name: 'Founder Org', logoUrl: 'https://x/logo.png' }));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('org-1');
    expect(mockPerm).not.toHaveBeenCalled();
  });

  it('a holder still faces body validation after the gate: 400 on missing name/logo', async () => {
    as(['canManageOrganizations']);
    const res = await POST(req('holder-1', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Name and logo URL are required');
  });

  it('no token still gets 401 Sign in required', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/organizations', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });
});
