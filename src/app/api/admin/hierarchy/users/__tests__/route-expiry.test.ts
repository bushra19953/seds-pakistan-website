/**
 * @jest-environment node
 *
 * GET /api/admin/hierarchy/users roleExpiresAt surfacing (EXPIRY-UI
 * plan 7.9, section 5.2, contracts 2.2): the route joins roles/{uid}
 * for the chapter's visible users and emits each grant's expiresAt as
 * an ISO string under `roleExpiresAt`, null when there is no expiring
 * grant (no expiry on the record, or no record at all). Departed
 * members stay off the chart, expiry or not.
 */

import { NextRequest } from 'next/server';

const IST = 'seds-ist-chapter';
const EXPIRES_ISO = '2027-02-10T00:00:00.000Z';
const timestampLike = (iso: string) => ({ toDate: () => new Date(iso) });

type Row = { id: string; data: Record<string, any> };

const userRows: Row[] = [
  { id: 'exp-1', data: { displayName: 'Expiry Holder', email: 'expiry@example.com', role: 'member', chapterId: IST } },
  { id: 'plain-1', data: { displayName: 'Plain Holder', email: 'plain@example.com', role: 'member', chapterId: IST } },
  { id: 'gone-1', data: { displayName: 'Departed Holder', email: 'gone@example.com', role: 'member', chapterId: IST, memberStatus: 'departed' } },
];

const roleRows: Row[] = [
  { id: 'exp-1', data: { role: 'custom_poster_team_lead', expiresAt: timestampLike(EXPIRES_ISO) } },
  { id: 'plain-1', data: { role: 'member', expiresAt: null } },
];

function queryFor(rows: Row[]) {
  const make = (filters: Array<(r: Row) => boolean>): any => ({
    where: (field: string, op: string, value: any) => {
      let fn: (r: Row) => boolean = () => true;
      if (field === '__name__' && op === 'in') fn = (r) => (value as string[]).includes(r.id);
      else if (op === '==') fn = (r) => r.data[field] === value;
      else if (field === 'subordinateId' && op === 'in') fn = () => false;
      return make([...filters, fn]);
    },
    get: async () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { docs: matched.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })) };
    },
  });
  return make([]);
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'users') return queryFor(userRows);
    if (name === 'roles') return queryFor(roleRows);
    if (name === 'reporting_relationships') return queryFor([]);
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
  ensureAdminInitialized: jest.fn(() => true),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { uid: 'admin-global', role: 'superadmin' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => true),
  hasServerPermissionForUser: jest.fn(async () => true),
}));

import { GET } from '@/app/api/admin/hierarchy/users/route';

describe('GET /api/admin/hierarchy/users roleExpiresAt (expiry-ui plan 7.9)', () => {
  it('emits the grant expiry as ISO and null when absent, excluding departed members', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/admin/hierarchy/users?chapterId=${IST}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.users.map((u: any) => [u.id, u]));
    expect(byId['exp-1'].roleExpiresAt).toBe(EXPIRES_ISO);
    expect(byId['plain-1'].roleExpiresAt).toBeNull();
    expect(byId['gone-1']).toBeUndefined();
  });
});
