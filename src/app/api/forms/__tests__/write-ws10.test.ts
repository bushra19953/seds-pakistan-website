/**
 * @jest-environment node
 *
 * WS10 — forms group pins.
 *  - Static: the admin forms page performs no client Firestore write.
 *  - PATCH /api/forms: page payload + stamped updatedAt + mirror.
 *  - DELETE /api/forms: Firestore delete + mirror delete.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');

describe('WS10 forms static pins', () => {
  it('admin forms page performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'app/admin/forms/page.tsx'), 'utf8');
    expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    expect(src).toContain('/api/forms');
  });
});

const updates: Array<{ id: string; data: any }> = [];
const deletes: string[] = [];
const mirrors: Array<{ op: string; id: string; data?: any }> = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({
      doc: (id: string) => ({
        update: async (data: any) => { updates.push({ id, data }); },
        delete: async () => { deletes.push(id); },
      }),
      add: async () => ({ id: 'new-1' }),
    }),
  }),
  admin: { firestore: { FieldValue: { serverTimestamp: () => '__ST__' } }, auth: () => ({}) },
}));
jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'tok',
  verifyIdTokenString: async () => ({ uid: 'founder-1' }),
}));
jest.mock('@/lib/roles', () => ({ isFounder: () => true }));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/server/forms-supa', () => ({
  readFormsViaSupa: async () => ({ status: 'fallback' }),
  mirrorFormCreate: async () => {},
  mirrorFormUpdate: async (id: string, data: any) => { mirrors.push({ op: 'update', id, data }); },
  mirrorFormDelete: async (id: string) => { mirrors.push({ op: 'delete', id }); },
}));
jest.mock('@/lib/server/public-misc-supa-shared', () => ({ serializePublicMiscDoc: (d: any) => d }));

import { PATCH, DELETE } from '../route';
import { NextRequest } from 'next/server';

function req(body: any, method: string): NextRequest {
  return new NextRequest('http://localhost/api/forms', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 /api/forms writes', () => {
  beforeEach(() => { updates.length = 0; deletes.length = 0; mirrors.length = 0; });

  it('PATCH applies the page payload, stamps updatedAt, mirrors with ISO', async () => {
    const res = await PATCH(req({ id: 'f1', title: 'T', description: 'D', fields: [{ id: 'x' }] }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{
      id: 'f1',
      data: { title: 'T', description: 'D', fields: [{ id: 'x' }], updatedAt: '__ST__' },
    }]);
    expect(mirrors[0].op).toBe('update');
    expect(typeof mirrors[0].data.updatedAt).toBe('string');
  });

  it('DELETE removes + mirrors', async () => {
    const res = await DELETE(req({ id: 'f9' }, 'DELETE'));
    expect(res.status).toBe(200);
    expect(deletes).toEqual(['f9']);
    expect(mirrors).toEqual([{ op: 'delete', id: 'f9' }]);
  });
});
