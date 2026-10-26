/**
 * @jest-environment node
 *
 * WS10 — projects group pins.
 *  - Static: admin projects page and lib/client-actions perform no
 *    client Firestore write; both go through the server routes.
 *  - POST /api/admin/projects: Firestore primary set (merge) with
 *    timestampFields stamped serverTimestamp, audit_logs entry in
 *    logAuditEntry's stored shape, mirror via the seam bridge with
 *    ISO timestamps; delete mirrors as delete. Mirror OFF state:
 *    primary write still happens, bridge untouched.
 *  - POST /api/projects (public create): any verified session,
 *    Firestore add + best-effort mirror; NOT flag-gated.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 projects static pins', () => {
  it('admin projects page performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'app/admin/projects/page.tsx'), 'utf8');
    expect(src).not.toMatch(/firestore-wrapper/);
    expect(src).not.toMatch(/from '@\/lib\/audit-logging'|logAuditEntry\(/);
    expect(src).toContain("/api/admin/projects");
  });
  it('client-actions performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'lib/client-actions.ts'), 'utf8');
    expect(src).not.toMatch(/firestore-wrapper/);
    expect(src).not.toMatch(/from 'firebase\/firestore'/);
    expect(src).toContain("/api/projects");
  });
});

/* ------------------------------------------------------------ route fakes */
const sets: Array<{ path: string; data: any; opts: any }> = [];
const deletes: string[] = [];
const adds: Array<{ col: string; data: any }> = [];
const bridge: Array<{ op: string; id: string; data?: any }> = [];
let surfaceOn = true;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'generated-1',
        set: async (data: any, opts: any) => { sets.push({ path: `${name}/${id}`, data, opts }); },
        delete: async () => { deletes.push(`${name}/${id}`); },
      }),
      add: async (data: any) => { adds.push({ col: name, data }); return { id: 'added-1' }; },
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__', increment: (n: number) => `__INC_${n}__` },
  Timestamp: { fromDate: (d: Date) => d },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/projects-supa', () => ({
  projectsSupaServerEnabled: () => surfaceOn,
  selectProjectList: () => ({}),
  supaFindProjectBySlugOrId: async () => null,
  supaListProjects: async () => [],
  supaSetProject: async (id: string, data: any) => { bridge.push({ op: 'set', id, data }); },
  supaUpdateProject: async (id: string, data: any) => { bridge.push({ op: 'update', id, data }); return true; },
  supaDeleteProject: async (id: string) => { bridge.push({ op: 'delete', id }); },
}));

import { POST as adminPOST } from '../route';
import { POST as publicPOST } from '../../../projects/route';
import { NextRequest } from 'next/server';

function req(url: string, body: any): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/admin/projects', () => {
  beforeEach(() => { sets.length = 0; deletes.length = 0; adds.length = 0; bridge.length = 0; surfaceOn = true; });

  it('create: set merge + serverTimestamp fields + audit + set mirror with ISO', async () => {
    const res = await adminPOST(req('http://localhost/api/admin/projects', {
      op: 'set',
      data: { title: 'P', createdBy: 'admin-1' },
      timestampFields: ['createdAt', 'created_at', 'updatedAt', 'updated_at'],
      mirrorOp: 'set',
      audit: { action: 'project_created', payload: { title: 'P' } },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('generated-1');
    expect(sets).toEqual([{
      path: 'projects/generated-1',
      data: { title: 'P', createdBy: 'admin-1', createdAt: '__ST__', created_at: '__ST__', updatedAt: '__ST__', updated_at: '__ST__' },
      opts: { merge: true },
    }]);
    const audit = adds.find((a) => a.col === 'audit_logs');
    expect(audit?.data).toMatchObject({
      action: 'project_created', actorUid: 'admin-1', targetUidOrResource: 'generated-1',
      payload: { title: 'P', projectId: 'generated-1' }, timestamp: '__ST__',
    });
    expect(bridge).toHaveLength(1);
    expect(bridge[0].op).toBe('set');
    expect(typeof bridge[0].data.createdAt).toBe('string');
  });

  it('delete: primary delete + audit + delete mirror', async () => {
    const res = await adminPOST(req('http://localhost/api/admin/projects', {
      op: 'delete', id: 'p9', mirrorOp: 'delete',
      audit: { action: 'project_deleted', target: 'p9', payload: { projectId: 'p9' } },
    }));
    expect(res.status).toBe(200);
    expect(deletes).toEqual(['projects/p9']);
    expect(bridge).toEqual([{ op: 'delete', id: 'p9' }]);
  });

  it('flag OFF: primary write still lands, bridge untouched', async () => {
    surfaceOn = false;
    const res = await adminPOST(req('http://localhost/api/admin/projects', {
      op: 'set', id: 'p1', data: { title: 'X' }, timestampFields: [], mirrorOp: 'set',
    }));
    expect(res.status).toBe(200);
    expect(sets).toHaveLength(1);
    expect(bridge).toHaveLength(0);
  });
});

describe('WS10 POST /api/projects (public create)', () => {
  beforeEach(() => { adds.length = 0; bridge.length = 0; surfaceOn = true; });

  it('adds to Firestore with serverTimestamp and mirrors as set', async () => {
    const res = await publicPOST(req('http://localhost/api/projects', {
      data: { title: 'Pub', slug: 'pub' },
      timestampFields: ['created_at', 'updated_at'],
    }));
    expect(res.status).toBe(201);
    const add = adds.find((a) => a.col === 'projects');
    expect(add?.data).toMatchObject({ title: 'Pub', slug: 'pub', created_at: '__ST__', updated_at: '__ST__' });
    expect(bridge).toHaveLength(1);
    expect(bridge[0].op).toBe('set');
    expect(typeof bridge[0].data.created_at).toBe('string');
  });

  it('rejects a payload without title/slug', async () => {
    const res = await publicPOST(req('http://localhost/api/projects', { data: { title: 'x' } }));
    expect(res.status).toBe(400);
  });
});
