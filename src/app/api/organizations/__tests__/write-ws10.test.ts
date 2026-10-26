/**
 * @jest-environment node
 *
 * WS10 — organizations group pins.
 *  - Static: the admin organizations page performs no client
 *    Firestore write.
 *  - POST now carries isGlobal (dropped before WS10).
 *  - PATCH: allowlisted fields; updatedAt stamped only when
 *    stampUpdatedAt is set (save-edit/toggle) and never for the
 *    drag-reorder writes; mirror update follows.
 *  - DELETE: Firestore delete + mirror delete.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');

describe('WS10 organizations static pins', () => {
  it('admin organizations page performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'app/admin/organizations/page.tsx'), 'utf8');
    expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    expect(src).toContain('/api/organizations');
  });
});

/* ------------------------------------------------------------ route fakes */
const adds: any[] = [];
const updates: Array<{ id: string; data: any }> = [];
const deletes: string[] = [];
const mirrors: Array<{ op: string; id: string; data?: any }> = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({
      add: async (data: any) => { adds.push(data); return { id: 'org-1' }; },
      doc: (id: string) => ({
        update: async (data: any) => { updates.push({ id, data }); },
        delete: async () => { deletes.push(id); },
      }),
    }),
  }),
  admin: { auth: () => ({}) },
}));
jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'tok',
  verifyIdTokenString: async () => ({ uid: 'founder-1' }),
}));
jest.mock('@/lib/roles', () => ({ isFounder: () => true }));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/finance/public-org-gate', () => ({ filterPublicOrganizations: (x: any) => x }));
jest.mock('@/lib/server/organizations-supa', () => ({
  readOrganizationsViaSupa: async () => ({ status: 'fallback' }),
  mapSupaOrganizationForList: (d: any) => d,
  mirrorOrganizationCreate: async (id: string, data: any) => { mirrors.push({ op: 'create', id, data }); },
  mirrorOrganizationUpdate: async (id: string, data: any) => { mirrors.push({ op: 'update', id, data }); },
  mirrorOrganizationDelete: async (id: string) => { mirrors.push({ op: 'delete', id }); },
}));

import { POST, PATCH, DELETE } from '../route';
import { NextRequest } from 'next/server';

function req(body: any, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/organizations', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 /api/organizations writes', () => {
  beforeEach(() => { adds.length = 0; updates.length = 0; deletes.length = 0; mirrors.length = 0; });

  it('POST carries isGlobal through to Firestore + mirror', async () => {
    const res = await POST(req({
      name: 'Org', logoUrl: 'https://x/logo.png', isGlobal: false, description: 'd',
    }));
    expect(res.status).toBe(200);
    expect(adds[0]).toMatchObject({ name: 'Org', isGlobal: false });
    expect(mirrors[0]).toMatchObject({ op: 'create', id: 'org-1' });
    expect(mirrors[0].data.isGlobal).toBe(false);
  });

  it('PATCH save-edit stamps updatedAt; reorder does not', async () => {
    let res = await PATCH(req({ id: 'o1', fields: { name: 'New' }, stampUpdatedAt: true }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(updates[0].data.name).toBe('New');
    expect(updates[0].data.updatedAt).toBeInstanceOf(Date);
    expect(typeof mirrors[0].data.updatedAt).toBe('string');

    updates.length = 0; mirrors.length = 0;
    res = await PATCH(req({ id: 'o1', fields: { displayOrder: 4, evil: 'x' } }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(updates[0].data).toEqual({ displayOrder: 4 });
  });

  it('DELETE removes + mirrors', async () => {
    const res = await DELETE(req({ id: 'o9' }, 'DELETE'));
    expect(res.status).toBe(200);
    expect(deletes).toEqual(['o9']);
    expect(mirrors).toEqual([{ op: 'delete', id: 'o9' }]);
  });
});
