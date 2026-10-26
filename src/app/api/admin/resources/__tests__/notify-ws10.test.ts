/**
 * @jest-environment node
 *
 * WS10 — resources group pins.
 *  - Static: the three admin resources pages perform no client
 *    Firestore write; writes go through /api/resources (POST/PATCH)
 *    and /api/admin/resources/notify.
 *  - PATCH /api/resources: allowlisted update + ISO mirror, with
 *    stampPublishedAt / stampDeletedAt carrying the serverTimestamp
 *    fields the client write set.
 *  - POST /api/admin/resources/notify (residual #3): per-recipient
 *    Firestore add + mirrorNotificationCreate with the exact payload
 *    the page sent; NO push is sent (replica parity: the wrapper
 *    dispatch's push handler returns early when payload.userId is
 *    absent, and this payload never carried one).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 resources static pins', () => {
  for (const rel of [
    'app/admin/resources/page.tsx',
    'app/admin/resources/new/page.tsx',
    'app/admin/resources/edit/page.tsx',
  ]) {
    it(`${rel} performs no client Firestore write`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/firestore-wrapper/);
      expect(src).toContain('serverWrite');
    });
  }
});

/* ------------------------------------------------------------ route fakes */
const adds: Array<{ path: string; data: any }> = [];
const updates: Array<{ path: string; data: any }> = [];
const mirrorUpdates: Array<{ id: string; data: any }> = [];
const notifMirrors: Array<{ path: string; id: string; data: any }> = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        update: async (data: any) => { updates.push({ path: `${name}/${id}`, data }); },
        collection: (sub: string) => ({
          add: async (data: any) => {
            adds.push({ path: `${name}/${id}/${sub}`, data });
            return { id: `notif-${adds.length}` };
          },
        }),
      }),
      add: async () => ({ id: 'new-1' }),
    }),
  }),
  admin: {
    auth: () => ({}),
    firestore: { FieldValue: { serverTimestamp: () => '__ST__' } },
  },
}));

jest.mock('@/lib/auth/verifySession', () => ({
  extractBearerToken: () => 'tok',
  verifyIdTokenString: async () => ({ uid: 'founder-uid' }),
}));
jest.mock('@/lib/roles', () => ({ isFounder: () => true }));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/server/resources-supa', () => ({
  readResourcesViaSupa: async () => ({ status: 'fallback' }),
  mirrorResourceCreate: async () => {},
  mirrorResourceUpdate: async (id: string, data: any) => { mirrorUpdates.push({ id, data }); },
}));
jest.mock('@/lib/server/public-misc-supa-shared', () => ({
  serializePublicMiscDoc: (d: any) => d,
}));
jest.mock('@/lib/server/notifications-supa-seam', () => ({
  userNotificationsPath: (uid: string) => `users/${uid}/notifications`,
  mirrorNotificationCreate: async (path: string, id: string, data: any) => {
    notifMirrors.push({ path, id, data });
    return true;
  },
}));

import { PATCH } from '../../../resources/route';
import { POST as notifyPOST } from '../notify/route';
import { NextRequest } from 'next/server';

function req(url: string, body: any, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 PATCH /api/resources', () => {
  beforeEach(() => { updates.length = 0; mirrorUpdates.length = 0; });

  it('applies the client payload fields and stamps publishedAt only on request', async () => {
    const res = await PATCH(req('http://localhost/api/resources', {
      id: 'r1', title: 'T', description: 'D', url: 'https://x', published: true, stampPublishedAt: true, evil: 'drop-me',
    }, 'PATCH') as any);
    expect(res.status).toBe(200);
    expect(updates).toEqual([{
      path: 'resources/r1',
      data: { title: 'T', description: 'D', url: 'https://x', published: true, updatedAt: '__ST__', publishedAt: '__ST__' },
    }]);
    expect(mirrorUpdates[0].id).toBe('r1');
    expect(typeof mirrorUpdates[0].data.updatedAt).toBe('string');
    expect(mirrorUpdates[0].data.evil).toBeUndefined();
  });

  it('soft-delete stamps deletedAt', async () => {
    await PATCH(req('http://localhost/api/resources', { id: 'r2', deleted: true, stampDeletedAt: true }, 'PATCH') as any);
    expect(updates[0].data).toMatchObject({ deleted: true, deletedAt: '__ST__' });
  });
});

describe('WS10 POST /api/admin/resources/notify', () => {
  beforeEach(() => { adds.length = 0; notifMirrors.length = 0; });

  it('writes + mirrors one notification per recipient with the page payload', async () => {
    const res = await notifyPOST(req('http://localhost/api/admin/resources/notify', {
      userIds: ['u1', 'u2'],
      notification: { title: 'Opportunity: X', body: 'B', link: '', competitionId: 'c1' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2 });
    expect(adds.map((a) => a.path)).toEqual(['users/u1/notifications', 'users/u2/notifications']);
    expect(adds[0].data).toEqual({
      title: 'Opportunity: X', body: 'B', link: '', competitionId: 'c1', isRead: false, timestamp: '__ST__',
    });
    expect(notifMirrors.map((m) => m.path)).toEqual(['users/u1/notifications', 'users/u2/notifications']);
    expect(typeof notifMirrors[0].data.timestamp).toBe('string');
  });

  it('rejects an empty recipient list', async () => {
    const res = await notifyPOST(req('http://localhost/api/admin/resources/notify', {
      userIds: [], notification: { title: 'x' },
    }));
    expect(res.status).toBe(400);
  });
});
