/**
 * @jest-environment node
 *
 * WS10 — final small-writes pins (badges, pages/timeline, seed,
 * award-badge).
 *  - Static: all seven client files perform no client Firestore
 *    write.
 *  - Badges route: create stamps + uniqueness 409 with the page's
 *    exact message; update stamps too (the page rewrote createdAt
 *    on update); delete.
 *  - Award-badge route: arrayUnion update; the replica's
 *    leaderboard-cache stamp lands ONLY when the badge is new
 *    (change-gate parity).
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 small-writes static pins', () => {
  for (const rel of [
    'app/admin/badges/page.tsx',
    'app/admin/seed/page.tsx',
    'app/admin/legal-documents/page.tsx',
    'app/admin/pages/page.tsx',
    'app/admin/pages/contact/page.tsx',
    'app/admin/timeline/page.tsx',
    'components/admin/users/award-badge-dialog.tsx',
  ]) {
    it(`${rel} performs no client Firestore write`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    });
  }
});

/* ------------------------------------------------------------ route fakes */
const badgeSets: Array<{ data: any }> = [];
const badgeUpdates: Array<{ data: any }> = [];
const badgeDeletes: number[] = [];
let badgeExists = false;
const userUpdates: Array<{ data: any }> = [];
const cacheSets: Array<{ data: any }> = [];
let userBadges: string[] = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => name === 'badges'
          ? { exists: badgeExists, data: () => ({}) }
          : { exists: true, data: () => ({ badges: userBadges }) },
        set: async (data: any, opts?: any) => {
          if (name === 'badges') badgeSets.push({ data });
          if (name === 'cache') cacheSets.push({ data });
        },
        update: async (data: any) => {
          if (name === 'badges') badgeUpdates.push({ data });
          if (name === 'users') userUpdates.push({ data });
        },
        delete: async () => { badgeDeletes.push(1); },
      }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ST__',
    arrayUnion: (...xs: string[]) => `__AU_${xs.join(',')}__`,
  },
  Timestamp: { now: () => '__NOW__' },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));

/* Gamification flip Phase 2 (U3/U4): mirror seams, captured. */
const mirrorCalls: Array<{ method: string; args: any[] }> = [];
jest.mock('@/lib/applications-supa', () => ({
  mirrorSetDoc: async (...args: any[]) => { mirrorCalls.push({ method: 'mirrorSetDoc', args }); return true; },
  mirrorDeleteDoc: async (...args: any[]) => { mirrorCalls.push({ method: 'mirrorDeleteDoc', args }); return true; },
}));
const usersPrimaryFlushes: Array<{ ops: any[] }> = [];
jest.mock('@/lib/server/supa-identity-primary', () => ({
  flushPendingUsersPrimaryOps: async (ops: any[]) => { usersPrimaryFlushes.push({ ops }); },
}));

import { POST as badgesPOST } from '../route';
import { POST as awardPOST } from '../../users/award-badge/route';
import { NextRequest } from 'next/server';

function req(url: string, body: any): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/admin/badges', () => {
  beforeEach(() => { badgeSets.length = 0; badgeUpdates.length = 0; badgeDeletes.length = 0; badgeExists = false; mirrorCalls.length = 0; });

  it('create: stamps both timestamps and sets', async () => {
    const res = await badgesPOST(req('http://localhost/api/admin/badges', {
      op: 'create', slug: 'pioneer', payload: { slug: 'pioneer', name: 'Pioneer', createdBy: 'admin-1' },
    }));
    expect(res.status).toBe(200);
    expect(badgeSets[0].data).toMatchObject({ slug: 'pioneer', createdAt: '__ST__', updatedAt: '__ST__' });
  });

  it('U3 create: mirrors to fs_badges with the same fields and ISO timestamps', async () => {
    const res = await badgesPOST(req('http://localhost/api/admin/badges', {
      op: 'create', slug: 'pioneer', payload: { slug: 'pioneer', name: 'Pioneer', createdBy: 'admin-1' },
    }));
    expect(res.status).toBe(200);
    expect(mirrorCalls).toHaveLength(1);
    const [collection, id, payload] = mirrorCalls[0].args;
    expect(mirrorCalls[0].method).toBe('mirrorSetDoc');
    expect(collection).toBe('badges');
    expect(id).toBe('pioneer');
    expect(payload).toMatchObject({ slug: 'pioneer', name: 'Pioneer', createdBy: 'admin-1' });
    expect(typeof payload.createdAt).toBe('string');
    expect(payload.createdAt).not.toBe('__ST__');
    expect(Number.isNaN(Date.parse(payload.createdAt))).toBe(false);
    expect(payload.updatedAt).toBe(payload.createdAt);
  });

  it('U3 create on existing slug: 409 and NO mirror call', async () => {
    badgeExists = true;
    const res = await badgesPOST(req('http://localhost/api/admin/badges', {
      op: 'create', slug: 'pioneer', payload: { slug: 'pioneer' },
    }));
    expect(res.status).toBe(409);
    expect(mirrorCalls).toEqual([]);
  });

  it('create on existing slug: 409 with the page message', async () => {
    badgeExists = true;
    const res = await badgesPOST(req('http://localhost/api/admin/badges', {
      op: 'create', slug: 'pioneer', payload: { slug: 'pioneer' },
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('A badge with this slug already exists');
    expect(badgeSets).toHaveLength(0);
  });

  it('update: stamps too (page parity); delete removes', async () => {
    let res = await badgesPOST(req('http://localhost/api/admin/badges', {
      op: 'update', slug: 'pioneer', payload: { slug: 'pioneer', name: 'P2' },
    }));
    expect(res.status).toBe(200);
    expect(badgeUpdates[0].data).toMatchObject({ createdAt: '__ST__', updatedAt: '__ST__' });
    res = await badgesPOST(req('http://localhost/api/admin/badges', { op: 'delete', slug: 'pioneer' }));
    expect(res.status).toBe(200);
    expect(badgeDeletes).toHaveLength(1);
  });

  it('U3 update mirrors via mirrorSetDoc; delete mirrors via mirrorDeleteDoc', async () => {
    let res = await badgesPOST(req('http://localhost/api/admin/badges', {
      op: 'update', slug: 'pioneer', payload: { slug: 'pioneer', name: 'P2' },
    }));
    expect(res.status).toBe(200);
    expect(mirrorCalls).toHaveLength(1);
    expect(mirrorCalls[0].method).toBe('mirrorSetDoc');
    expect(mirrorCalls[0].args[0]).toBe('badges');
    expect(mirrorCalls[0].args[1]).toBe('pioneer');
    expect(mirrorCalls[0].args[2]).toMatchObject({ slug: 'pioneer', name: 'P2' });
    res = await badgesPOST(req('http://localhost/api/admin/badges', { op: 'delete', slug: 'pioneer' }));
    expect(res.status).toBe(200);
    expect(mirrorCalls).toHaveLength(2);
    expect(mirrorCalls[1]).toEqual({ method: 'mirrorDeleteDoc', args: ['badges', 'pioneer'] });
  });
});

describe('WS10 POST /api/admin/users/award-badge', () => {
  beforeEach(() => { userUpdates.length = 0; cacheSets.length = 0; userBadges = []; usersPrimaryFlushes.length = 0; });

  it('new badge: arrayUnion update + leaderboard cache stamp', async () => {
    const res = await awardPOST(req('http://localhost/api/admin/users/award-badge', {
      userUid: 'u1', slug: 'pioneer',
    }));
    expect(res.status).toBe(200);
    expect(userUpdates[0].data).toEqual({ badges: '__AU_pioneer__', updatedAt: '__ST__' });
    expect(cacheSets).toHaveLength(1);
    expect(cacheSets[0].data).toMatchObject({ invalidatedUser: 'u1' });
  });

  it('U4 new badge: badge union flushed to fs_users via the U-33 RMW seam', async () => {
    const res = await awardPOST(req('http://localhost/api/admin/users/award-badge', {
      userUid: 'u1', slug: 'pioneer',
    }));
    expect(res.status).toBe(200);
    expect(usersPrimaryFlushes).toEqual([
      { ops: [{ uid: 'u1', payload: { badges: '__AU_pioneer__' } }] },
    ]);
  });

  it('already-owned badge: update still lands, stamp skipped (change-gate parity)', async () => {
    userBadges = ['pioneer'];
    const res = await awardPOST(req('http://localhost/api/admin/users/award-badge', {
      userUid: 'u1', slug: 'pioneer',
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).awarded).toBe(false);
    expect(userUpdates).toHaveLength(1);
    expect(cacheSets).toHaveLength(0);
  });

  it('U4 already-owned badge: NO fs_users flush (mirror only when isNew)', async () => {
    userBadges = ['pioneer'];
    const res = await awardPOST(req('http://localhost/api/admin/users/award-badge', {
      userUid: 'u1', slug: 'pioneer',
    }));
    expect(res.status).toBe(200);
    expect(usersPrimaryFlushes).toEqual([]);
  });
});
