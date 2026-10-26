import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { mirrorBlogCreate } from '@/lib/server/blog-supa';

/**
 * POST /api/admin/blogs — WS10 create route for the ADMIN blog/new
 * page (previously a client addDoc through firestore-wrapper).
 *
 * This is deliberately NOT POST /api/blogs: that public-API route
 * takes a different named-field payload (authorId, no `body` /
 * `published` fields) — the shape mismatch is why the public
 * blog/new page stays unconverted (named in the WS10 report). This
 * route accepts the admin page's exact payload:
 *   - publish_date / unpublish_date arrive as ISO strings or null
 *     (the page's toTimestampOrNull) and land as Admin Timestamps /
 *     null on Firestore, ISO / null in the mirror;
 *   - createdAt / updatedAt are stamped server-side, and
 *     publishedAt is stamped only when status is 'published' —
 *     the page's exact conditional;
 *   - authorUid is stamped from the verified token (the page sent
 *     the same uid from its auth state).
 * Firestore primary + mirrorBlogCreate (best-effort seam).
 * `blogs` is not a webhook-dispatch collection: no replica effect.
 * Gate: verified session + canManageBlogs (the [id] route's gate).
 */

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageBlogs');
  } catch {
    allowed = false;
  }
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.title !== 'string' || !body.title.trim() || typeof body.body !== 'string') {
    return NextResponse.json({ error: 'Title and content are required' }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const toTimestamp = (v: unknown) =>
    typeof v === 'string' && v ? Timestamp.fromDate(new Date(v)) : null;

  const firestoreData: Record<string, any> = {
    ...body,
    authorUid: auth.user.userId,
    publish_date: toTimestamp(body.publish_date),
    unpublish_date: toTimestamp(body.unpublish_date),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(body.status === 'published' ? { publishedAt: FieldValue.serverTimestamp() } : {}),
  };
  const mirrorData: Record<string, any> = {
    ...body,
    authorUid: auth.user.userId,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(body.status === 'published' ? { publishedAt: nowIso } : {}),
  };

  const ref = await db.collection('blogs').add(firestoreData);
  await mirrorBlogCreate(ref.id, mirrorData);

  return NextResponse.json({ ok: true, id: ref.id }, { status: 201 });
}
