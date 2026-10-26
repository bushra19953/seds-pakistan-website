/**
 * POST /api/admin/resources/notify — WS10 route for the admin
 * resources page's "notify members about a competition" write
 * (notifications residual #3 in DEPLOY_READY_REPORT).
 *
 * The page used to addDoc users/{uid}/notifications directly from the
 * browser — a write no server seam ever saw, so it never mirrored to
 * fs_group_notifications and the notification was invisible on the
 * Supa read path. This route performs, per recipient:
 *   1. the Firestore add (Admin SDK, serverTimestamp) — primary;
 *   2. mirrorNotificationCreate through the notifications seam —
 *      the mirror its sibling notification writers already have.
 *
 * REPLICA PARITY (functions-accounting §8): the old client write went
 * through firestore-wrapper, whose dispatch for
 * users/{uid}/notifications reaches only handleNotificationPush in
 * the webhook replica. That handler reads `payload.userId` FIRST and
 * returns when it is absent — and this flow's payload never carried a
 * userId field. The push arm was therefore a proven no-op for this
 * flow, and this route deliberately does NOT send a push: adding one
 * would change downstream effects, not preserve them.
 *
 * Gate: founder or canManageResources (the resources POST gate).
 * Body: { userIds: string[], notification: { title, body, link,
 *         competitionId } } — the exact payload fields the page sent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import {
  mirrorNotificationCreate,
  userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await verifyIdTokenString(token);
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  if (!isFounder(decoded.uid)) {
    const allowed = await hasServerPermissionForUser(db, decoded.uid, 'canManageResources');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const userIds: string[] = Array.isArray(body.userIds)
    ? body.userIds.filter((u: unknown): u is string => typeof u === 'string' && u.length > 0)
    : [];
  const notif = (body.notification ?? {}) as Record<string, any>;
  if (userIds.length === 0) {
    return NextResponse.json({ error: 'userIds is required' }, { status: 400 });
  }

  const payload: Record<string, any> = {
    title: typeof notif.title === 'string' ? notif.title : '',
    body: typeof notif.body === 'string' ? notif.body : '',
    link: typeof notif.link === 'string' ? notif.link : '',
    competitionId: typeof notif.competitionId === 'string' ? notif.competitionId : null,
    isRead: false,
  };

  const nowIso = new Date().toISOString();
  let sent = 0;
  for (const uid of userIds) {
    const ref = await db
      .collection('users')
      .doc(uid)
      .collection('notifications')
      .add({ ...payload, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    await mirrorNotificationCreate(userNotificationsPath(uid), ref.id, {
      ...payload,
      timestamp: nowIso,
    });
    sent += 1;
  }

  return NextResponse.json({ sent });
}
