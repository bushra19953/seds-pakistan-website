/**
 * @jest-environment node
 *
 * GET /api/admin/users roleExpiresAt surfacing (EXPIRY-UI plan 7.9,
 * section 5.1, contracts 2.2): roles/{uid}.expiresAt (a Firestore
 * Timestamp on the grant record) is emitted on each row as an ISO
 * string under `roleExpiresAt`, and null when the grant carries no
 * expiry or no grant record exists. Pinned in BOTH engines: Path A
 * (idle paging) and Path B (RAM search directory). This file has its
 * own fixtures on purpose: the route's caches are module-level, so it
 * gets a fresh module instance.
 */

import { NextRequest } from 'next/server';

type Row = { id: string; data: Record<string, any> };

const IST = 'seds-ist-chapter';
const EXPIRES_ISO = '2027-01-21T00:00:00.000Z';

const state = {
  authContext: { userId: 'admin-global', role: 'superadmin' } as any,
};

const timestampLike = (iso: string) => ({ toDate: () => new Date(iso) });

const userRows: Row[] = [
  { id: 'exp-1', data: { displayName: 'Expiry Holder', email: 'expiry@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'plain-1', data: { displayName: 'Plain Holder', email: 'plain@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'nogrant-1', data: { displayName: 'No Grant', email: 'nogrant@example.com', whatsapp: '', role: 'member', chapterId: IST } },
  { id: 'admin-global', data: { displayName: 'Global Admin', email: 'g@example.com', whatsapp: '', role: 'superadmin' } },
];

const roleRows: Row[] = [
  { id: 'exp-1', data: { role: 'custom_poster_team_lead', expiresAt: timestampLike(EXPIRES_ISO) } },
  { id: 'plain-1', data: { role: 'member' } },
  // nogrant-1 intentionally has no roles/{uid} doc.
];

function rowFilter(field: string, op: string, value: any) {
  if (field === '__name__' && op === 'in') return (r: Row) => (value as string[]).includes(r.id);
  if (op === '==') return (r: Row) => r.data[field] === value;
  return () => true;
}

function makeChain(rows: Row[], filters: Array<(r: Row) => boolean> = []): any {
  const chain: any = {
    where: (f: string, op: string, v: any) => makeChain(rows, [...filters, rowFilter(f, op, v)]),
    orderBy: () => chain,
    startAfter: () => chain,
    limit: () => chain,
    select: () => chain,
    get: async () => {
      const matched = rows.filter((r) => filters.every((fn) => fn(r)));
      return {
        docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })),
        size: matched.length,
        empty: matched.length === 0,
      };
    },
  };
  return chain;
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') {
      return {
        ...makeChain(userRows),
        doc: (id: string) => ({
          get: async () => {
            const r = userRows.find((u) => u.id === id);
            return { exists: !!r, id, data: () => (r ? { ...r.data } : undefined) };
          },
        }),
      };
    }
    if (name === 'roles') return makeChain(roleRows);
    if (name === 'permissions') {
      return { doc: (_id: string) => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  withAuth: jest.fn(async (_req: any, handler: any) => handler(state.authContext)),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
  hasServerPermissionForUser: jest.fn(async () => true),
}));

import { GET } from '@/app/api/admin/users/route';

async function getJson(qs = '') {
  const res = await GET(new NextRequest(`http://localhost/api/admin/users${qs}`));
  return { res, body: await res.json() };
}

function rowByUid(body: any, uid: string) {
  return body.users.find((u: any) => u.uid === uid);
}

describe('GET /api/admin/users roleExpiresAt (expiry-ui plan 7.9)', () => {
  it('Path A: emits the grant expiry as ISO and null when absent', async () => {
    const { res, body } = await getJson();
    expect(res.status).toBe(200);
    expect(rowByUid(body, 'exp-1').roleExpiresAt).toBe(EXPIRES_ISO);
    expect(rowByUid(body, 'exp-1').role).toBe('custom_poster_team_lead');
    expect(rowByUid(body, 'plain-1').roleExpiresAt).toBeNull();
    expect(rowByUid(body, 'nogrant-1').roleExpiresAt).toBeNull();
  });

  it('Path B: search rows carry the same roleExpiresAt values', async () => {
    const { res, body } = await getJson('?q=expiry');
    expect(res.status).toBe(200);
    expect(rowByUid(body, 'exp-1')).toBeDefined();
    expect(rowByUid(body, 'exp-1').roleExpiresAt).toBe(EXPIRES_ISO);

    const plain = await getJson('?q=plain');
    expect(rowByUid(plain.body, 'plain-1').roleExpiresAt).toBeNull();
  });
});
