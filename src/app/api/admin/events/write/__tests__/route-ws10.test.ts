/**
 * @jest-environment node
 *
 * WS10 — events group pins.
 *  - Static: the five events client files perform no client
 *    Firestore write.
 *  - POST /api/admin/events/write: set/update/create with the
 *    timestampFields / millisFields / dateFields protocol and the
 *    supa-events seam mirrors.
 *  - Gate: without canManageEvents → 403, zero writes.
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../../..');

describe('WS10 events static pins', () => {
  for (const rel of [
    'app/admin/events/new/page.tsx',
    'app/admin/events/edit/page.tsx',
    'app/events/new/page.tsx',
    'app/events/register/page.tsx',
    'components/admin/events/event-attendees-panel.tsx',
  ]) {
    it(`${rel} performs no client Firestore write`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    });
  }
  it('attendees panel uses the registrations primary mode', () => {
    const src = readFileSync(join(root, 'components/admin/events/event-attendees-panel.tsx'), 'utf8');
    expect(src).toContain("mode: 'primary'");
  });
  it('register page uses PATCH /api/event-registrations', () => {
    const src = readFileSync(join(root, 'app/events/register/page.tsx'), 'utf8');
    expect(src).toContain("/api/event-registrations");
  });
});

/* ------------------------------------------------------------ route fakes */
const sets: Array<{ path: string; data: any }> = [];
const updates: Array<{ path: string; data: any }> = [];
const mirrors: Array<{ op: string; id: string; data: any }> = [];
let permitted = true;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'gen-1',
        set: async (data: any) => { sets.push({ path: `${name}/${id ?? 'gen-1'}`, data }); },
        update: async (data: any) => { updates.push({ path: `${name}/${id}`, data }); },
      }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
  Timestamp: {
    fromMillis: (ms: number) => `__TS_${ms}__`,
    fromDate: (d: Date) => `__TS_${d.toISOString()}__`,
  },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: async () => permitted,
}));
jest.mock('@/lib/supa-events/server-events', () => ({
  mirrorDocWrite: async (_c: string, id: string, data: any) => { mirrors.push({ op: 'set', id, data }); },
  mirrorDocUpdate: async (_c: string, id: string, data: any) => { mirrors.push({ op: 'update', id, data }); },
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/admin/events/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/admin/events/write', () => {
  beforeEach(() => { sets.length = 0; updates.length = 0; mirrors.length = 0; permitted = true; });

  it('set: stamps timestamps, converts millis dates, mirrors as set', async () => {
    const res = await POST(req({
      op: 'set', id: 'my-event',
      data: { id: 'my-event', title: 'T', deleted: false },
      timestampFields: ['createdAt', 'updatedAt'],
      millisFields: { startAt: 1760000000000, endAt: null },
    }));
    expect(res.status).toBe(200);
    expect(sets).toEqual([{
      path: 'events/my-event',
      data: { id: 'my-event', title: 'T', deleted: false, createdAt: '__ST__', updatedAt: '__ST__', startAt: '__TS_1760000000000__' },
    }]);
    expect(mirrors[0].op).toBe('set');
    expect(mirrors[0].data.startAt).toBe('2025-10-09T08:53:20.000Z');
    expect(mirrors[0].data.endAt).toBeUndefined();
  });

  it('update: Firestore update + mirror update', async () => {
    const res = await POST(req({ op: 'update', id: 'e1', data: { productId: 'p1' } }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ path: 'events/e1', data: { productId: 'p1' } }]);
    expect(mirrors).toEqual([{ op: 'update', id: 'e1', data: { productId: 'p1' } }]);
  });

  it('create: server id + dateFields conversion', async () => {
    const res = await POST(req({
      op: 'create',
      data: { title: 'D', date: '2026-11-01T00:00:00.000Z', published: false },
      timestampFields: ['createdAt'],
      dateFields: ['date'],
    }));
    expect(res.status).toBe(200);
    expect(sets[0].data.date).toBe('__TS_2026-11-01T00:00:00.000Z__');
    expect(sets[0].data.createdAt).toBe('__ST__');
    expect(mirrors[0].data.date).toBe('2026-11-01T00:00:00.000Z');
  });

  it('gate: without canManageEvents → 403, zero writes', async () => {
    permitted = false;
    const res = await POST(req({ op: 'update', id: 'e1', data: { x: 1 } }));
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});
