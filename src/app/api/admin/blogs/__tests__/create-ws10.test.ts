/**
 * @jest-environment node
 *
 * WS10 — blog group pins.
 *  - Static: the admin blog new/edit pages perform no client
 *    Firestore write; the public blog/new page is NOT converted
 *    (named: POST /api/blogs gate/shape mismatch).
 *  - POST /api/admin/blogs: page payload stored with stamped
 *    timestamps, ISO dates → Admin Timestamps, publishedAt only for
 *    status 'published', authorUid from the token, mirror follows.
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');

describe('WS10 blog static pins', () => {
  it('admin blog new/edit pages perform no client Firestore write', () => {
    for (const rel of ['app/admin/blog/new/page.tsx', 'app/admin/blog/edit/page.tsx']) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    }
    expect(readFileSync(join(root, 'app/admin/blog/new/page.tsx'), 'utf8')).toContain('/api/admin/blogs');
    expect(readFileSync(join(root, 'app/admin/blog/edit/page.tsx'), 'utf8')).toContain('/api/admin/blogs/');
  });
});

const adds: Array<{ data: any }> = [];
const mirrors: Array<{ id: string; data: any }> = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: () => ({ add: async (data: any) => { adds.push({ data }); return { id: 'blog-1' }; } }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
  Timestamp: { fromDate: (d: Date) => `__TS_${d.toISOString()}__` },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'author-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/server/blog-supa', () => ({
  mirrorBlogCreate: async (id: string, data: any) => { mirrors.push({ id, data }); },
}));

import { POST } from '../route';
import { NextRequest } from 'next/server';

function req(body: any): NextRequest {
  return new NextRequest('http://localhost/api/admin/blogs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 POST /api/admin/blogs', () => {
  beforeEach(() => { adds.length = 0; mirrors.length = 0; });

  it('published: stamps publishedAt, converts dates, token authorUid, mirrors', async () => {
    const res = await POST(req({
      title: 'T', body: 'B', status: 'published', authorUid: 'spoof',
      publish_date: '2026-10-26T00:00:00.000Z', unpublish_date: null, slug: 't',
    }));
    expect(res.status).toBe(201);
    expect(adds[0].data).toMatchObject({
      title: 'T', authorUid: 'author-1', publish_date: '__TS_2026-10-26T00:00:00.000Z__',
      unpublish_date: null, createdAt: '__ST__', updatedAt: '__ST__', publishedAt: '__ST__',
    });
    expect(mirrors[0].id).toBe('blog-1');
    expect(mirrors[0].data.publish_date).toBe('2026-10-26T00:00:00.000Z');
    expect(typeof mirrors[0].data.publishedAt).toBe('string');
  });

  it('draft: no publishedAt anywhere', async () => {
    const res = await POST(req({ title: 'T', body: 'B', status: 'draft', publish_date: null, unpublish_date: null }));
    expect(res.status).toBe(201);
    expect(adds[0].data.publishedAt).toBeUndefined();
    expect(mirrors[0].data.publishedAt).toBeUndefined();
  });
});
