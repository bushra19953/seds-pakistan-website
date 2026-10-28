/**
 * @jest-environment node
 *
 * WS10 — announcements group pins.
 *  - Static: the admin announcements page performs no client
 *    Firestore write and no client audit write.
 *  - POST /api/admin/announcements: create (server id + set mirror +
 *    audit), update (update mirror, dateFields → Admin Timestamps,
 *    timestampFields → serverTimestamp/ISO), delete (delete mirror +
 *    audit), event-update (events write + the events seam mirror —
 *    the events-mirror fix: an event-doc write through this route
 *    must reach fs_events like every other event write route).
 *  - Flag OFF: primary writes still land, bridge untouched.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 announcements static pins', () => {
  it('admin announcements page performs no client Firestore write', () => {
    const src = readFileSync(join(root, 'app/admin/announcements/page.tsx'), 'utf8');
    expect(src).not.toMatch(/firestore-wrapper/);
    expect(src).not.toMatch(/from '@\/lib\/audit-logging'|logAuditEntry\(/);
    expect(src).not.toMatch(/mirrorAnnouncementViaRoute/);
    expect(src).toContain("/api/admin/announcements");
  });
});

/* ------------------------------------------------------------ route fakes */
const sets: Array<{ path: string; data: any }> = [];
const updates: Array<{ path: string; data: any }> = [];
const deletes: string[] = [];
const auditAdds: any[] = [];
const bridge: Array<{ op: string; id: string; data?: any }> = [];
const eventMirrors: Array<{ collection: string; id: string; data: any }> = [];
let surfaceOn = true;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'gen-1',
        set: async (data: any) => { sets.push({ path: `${name}/${id ?? 'gen-1'}`, data }); },
        update: async (data: any) => { updates.push({ path: `${name}/${id}`, data }); },
        delete: async () => { deletes.push(`${name}/${id}`); },
      }),
      add: async (data: any) => { auditAdds.push(data); return { id: 'a1' }; },
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
  Timestamp: { fromDate: (d: Date) => `__TS_${d.toISOString()}__` },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/announcements-supa', () => ({
  announcementsSupaServerEnabled: () => surfaceOn,
  supaSetAnnouncement: async (id: string, data: any) => { bridge.push({ op: 'set', id, data }); },
  supaUpdateAnnouncement: async (id: string, data: any) => { bridge.push({ op: 'update', id, data }); return true; },
  supaDeleteAnnouncement: async (id: string) => { bridge.push({ op: 'delete', id }); },
}));
jest.mock('@/lib/supa-events/server-events', () => ({
  mirrorDocUpdate: async (collection: string, id: string, data: any) => {
    eventMirrors.push({ collection, id, data });
  },
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/admin/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/admin/announcements', () => {
  beforeEach(() => {
    sets.length = 0; updates.length = 0; deletes.length = 0;
    auditAdds.length = 0; bridge.length = 0; eventMirrors.length = 0; surfaceOn = true;
  });

  it('create: set with stamped fields + date conversion + set mirror + audit', async () => {
    const res = await POST(req({
      op: 'create',
      data: { title: 'T', publish_date: '2026-10-26T00:00:00.000Z', expiresAt: null, created_by: 'admin-1' },
      timestampFields: ['updated_at', 'created_at'],
      dateFields: ['publish_date', 'expiresAt'],
      audit: { action: 'announcement_created', payload: { title: 'T' } },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('gen-1');
    expect(sets).toEqual([{
      path: 'announcements/gen-1',
      data: {
        title: 'T', publish_date: '__TS_2026-10-26T00:00:00.000Z__', expiresAt: null,
        created_by: 'admin-1', updated_at: '__ST__', created_at: '__ST__',
      },
    }]);
    expect(bridge[0].op).toBe('set');
    expect(bridge[0].data.publish_date).toBe('2026-10-26T00:00:00.000Z');
    expect(typeof bridge[0].data.updated_at).toBe('string');
    expect(auditAdds[0]).toMatchObject({ action: 'announcement_created', targetUidOrResource: 'gen-1' });
  });

  it('update toggle: no audit, update mirror', async () => {
    const res = await POST(req({ op: 'update', id: 'a9', data: { status: 'draft' } }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ path: 'announcements/a9', data: { status: 'draft' } }]);
    expect(bridge).toEqual([{ op: 'update', id: 'a9', data: { status: 'draft' } }]);
    expect(auditAdds).toHaveLength(0);
  });

  it('delete: primary delete + delete mirror + audit', async () => {
    const res = await POST(req({
      op: 'delete', id: 'a9',
      audit: { action: 'announcement_deleted', target: 'a9', payload: { title: 'T' } },
    }));
    expect(res.status).toBe(200);
    expect(deletes).toEqual(['announcements/a9']);
    expect(bridge).toEqual([{ op: 'delete', id: 'a9' }]);
    expect(auditAdds[0]).toMatchObject({ action: 'announcement_deleted' });
  });

  it('event-update: events write + events seam mirror, no announcements bridge, no audit', async () => {
    const res = await POST(req({ op: 'event-update', id: 'e1', data: { showInTicker: true } }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ path: 'events/e1', data: { showInTicker: true } }]);
    expect(eventMirrors).toEqual([{ collection: 'events', id: 'e1', data: { showInTicker: true } }]);
    expect(bridge).toHaveLength(0);
    expect(auditAdds).toHaveLength(0);
  });

  it('event-update priority: mirrors the priority write too', async () => {
    const res = await POST(req({ op: 'event-update', id: 'e2', data: { priority: 5 } }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ path: 'events/e2', data: { priority: 5 } }]);
    expect(eventMirrors).toEqual([{ collection: 'events', id: 'e2', data: { priority: 5 } }]);
    expect(bridge).toHaveLength(0);
  });

  it('flag OFF: primary lands, bridge untouched', async () => {
    surfaceOn = false;
    const res = await POST(req({ op: 'update', id: 'a1', data: { priority: 3 } }));
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(bridge).toHaveLength(0);
  });
});
