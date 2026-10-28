/**
 * @jest-environment node
 *
 * GET /api/admin/users/[uid]/contact (contact-gating fix,
 * 2026-10-28) — the admin read doorway for the gated contact
 * record. Its gate intentionally equals the Firestore rules gate
 * for users/{uid}/private/contact: canManageUsers via
 * hasServerPermissionForUser, the same auth pattern as the sibling
 * [uid] routes (depart/reinstate).
 *
 * Pins:
 *  1. Unauthenticated -> 401.
 *  2. Authenticated without canManageUsers -> 403, no contact data.
 *  3. Privileged caller -> 200 with { email, whatsapp,
 *     whatsappNumber }: email resolved contact-first with the Auth
 *     fallback (mocked doorway), whatsapp fields from the contact
 *     record.
 *  4. Unknown user -> 404.
 */

import { NextRequest } from 'next/server';

const mockState = {
  authResult: { authenticated: false } as any,
  canManage: false,
};

const mockContacts: Record<string, any> = {
  'u-1': { email: 'ayesha@example.com', whatsapp: '03001111111', whatsappNumber: '03001111111' },
};
const mockResolvedEmails: Record<string, string> = {
  'u-1': 'ayesha@example.com',
  'u-auth-only': 'auth.only@example.com',
};

const mockDb = {
  collection: (name: string) => {
    if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => ({
        get: async () => ({
          exists: id === 'u-1' || id === 'u-auth-only',
          id,
          data: () => ({ displayName: 'A Person' }),
        }),
      }),
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => mockState.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockState.canManage),
}));

jest.mock('@/lib/server/user-contact', () => {
  const shared = jest.requireActual('@/lib/user-contact-shared');
  return {
    ...shared,
    getUserContact: async (_db: any, uid: string) => mockContacts[uid] ?? null,
    resolveUserEmail: async (_db: any, uid: string) => mockResolvedEmails[uid] ?? null,
  };
});

import { GET } from '@/app/api/admin/users/[uid]/contact/route';

function call(uid: string) {
  return GET(new NextRequest(`http://localhost/api/admin/users/${uid}/contact`), {
    params: { uid },
  } as any);
}

beforeEach(() => {
  mockState.authResult = { authenticated: false };
  mockState.canManage = false;
});

describe('GET /api/admin/users/[uid]/contact', () => {
  it('1. unauthenticated caller gets 401', async () => {
    const res = await call('u-1');
    expect(res.status).toBe(401);
  });

  it('2. authenticated caller without canManageUsers gets 403 and no contact data', async () => {
    mockState.authResult = { authenticated: true, user: { userId: 'member-1', role: 'member' } };
    const res = await call('u-1');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.email).toBeUndefined();
    expect(body.whatsapp).toBeUndefined();
  });

  it('3. privileged caller receives the contact record', async () => {
    mockState.authResult = { authenticated: true, user: { userId: 'admin-1', role: 'superadmin' } };
    mockState.canManage = true;
    const res = await call('u-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      email: 'ayesha@example.com',
      whatsapp: '03001111111',
      whatsappNumber: '03001111111',
    });
  });

  it('3b. a user with no contact record still resolves email via the Auth fallback, whatsapp null', async () => {
    mockState.authResult = { authenticated: true, user: { userId: 'admin-1', role: 'superadmin' } };
    mockState.canManage = true;
    const res = await call('u-auth-only');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      email: 'auth.only@example.com',
      whatsapp: null,
      whatsappNumber: null,
    });
  });

  it('4. unknown user gets 404', async () => {
    mockState.authResult = { authenticated: true, user: { userId: 'admin-1', role: 'superadmin' } };
    mockState.canManage = true;
    const res = await call('ghost');
    expect(res.status).toBe(404);
  });
});
