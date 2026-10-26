/**
 * /api/notifications — the signed-in user's own notifications.
 *
 * Contract (G1, the client group, builds against exactly this):
 *
 *   Auth: Authorization: Bearer <Firebase ID token> on every method,
 *   verified with the shared verifySession helper (the tree's existing
 *   server auth pattern). No token / invalid token -> 401; Admin SDK
 *   uninitialized -> 500. Identity comes from the token's uid ONLY:
 *   this route performs no per-request user-doc reads.
 *
 *   GET -> 200 { notifications: Notification[] }
 *     The caller's notifications from users/{uid}/notifications,
 *     newest-first, at most 50 (optional ?limit=1..50 overrides).
 *     Each entry is the client listener's object shape: the document
 *     id plus its fields, { id, ...fields }, with every Timestamp
 *     value serialized as an ISO string.
 *     Source: when useSupa('notifications') is ON and Supabase is
 *     configured, the list is read through the notifications seam;
 *     on OFF / unconfigured / adapter error it reads Firestore,
 *     exactly as below. The Firestore read unions the two timestamp
 *     families this codebase writes (createdAt and timestamp): two
 *     bounded orderBy queries of `limit` docs each, merged, deduped,
 *     sorted newest-first in memory. Read budget: at most 2*limit
 *     document reads per GET.
 *
 *   PATCH — the mutations NotificationCenter performs today
 *   (updateDoc(ref, { isRead: true }); there is no other personal-
 *   notification mutation in the center):
 *     { id: string }            mark that one notification read
 *                               -> 200 { ok: true, updated: 1 }
 *                               -> 404 when the doc does not exist
 *     { all: true }             mark every unread notification in the
 *                               caller's loaded window (limit 50, the
 *                               center's own window) read
 *                               -> 200 { ok: true, updated: <count> }
 *     anything else             -> 400
 *     "Unread" mirrors the center's check exactly: isRead === false.
 *
 *   DELETE ?id=<id>  (or JSON body { id })
 *     Delete that one notification from the caller's own
 *     subcollection -> 200 { ok: true, deleted: "<id>" }; 400 with no
 *     id. (NotificationCenter performs no delete today; this exists
 *     for the G1 surface, scoped to the caller's subcollection only —
 *     an id can never reach another user's notifications.)
 *
 *   Mutations: Firestore is primary (unchanged semantics); when the
 *   Supabase surface is ON the same mutation is mirrored through the
 *   seam, non-throwing — a mirror failure never fails the request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import {
  SessionError,
  verifySession,
} from '@/lib/auth/verifySession';
import {
  deleteNotificationPrimaryFirst,
  listSupaUserNotifications,
  mirrorNotificationDelete,
  mirrorNotificationUpdate,
  updateNotificationPrimaryFirst,
  serializeNotificationData,
  sortAndLimitNotifications,
  userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LIMIT = 50;

type NotifDoc = { id: string } & Record<string, unknown>;

function parseLimit(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('limit');
  if (!raw) return MAX_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return MAX_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function authenticate(request: NextRequest): Promise<string> {
  const decoded = await verifySession(request);
  return decoded.uid;
}

function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof SessionError) {
    return NextResponse.json({ error: err.message }, { status: err.statusCode });
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Firestore list: union of the createdAt-ordered and timestamp-ordered
 * windows (each writer family orders by only one of them, and a
 * Firestore orderBy silently drops docs missing that field), merged
 * and sorted newest-first in memory.
 */
async function fetchFirestoreNotifications(
  db: FirebaseFirestore.Firestore,
  uid: string,
  limit: number,
): Promise<NotifDoc[]> {
  const col = db.collection('users').doc(uid).collection('notifications');
  const [byCreatedAt, byTimestamp] = await Promise.all([
    col.orderBy('createdAt', 'desc').limit(limit).get(),
    col.orderBy('timestamp', 'desc').limit(limit).get(),
  ]);
  const docs: NotifDoc[] = [];
  for (const snap of [byCreatedAt, byTimestamp]) {
    snap.docs.forEach((d: any) => {
      docs.push({ id: d.id, ...(d.data() as Record<string, unknown>) });
    });
  }
  return sortAndLimitNotifications(docs, limit).map((d) => ({
    ...serializeNotificationData(d),
    id: d.id,
  }));
}

export async function GET(request: NextRequest) {
  let uid: string;
  try {
    uid = await authenticate(request);
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = parseLimit(request);

  // Supabase surface ON: read through the seam. A null result means
  // OFF / unconfigured / adapter error — serve Firestore exactly.
  const supaDocs = await listSupaUserNotifications(uid, limit);
  if (supaDocs) {
    return NextResponse.json({ notifications: supaDocs });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Internal Server Error: Firestore not initialized' },
      { status: 500 },
    );
  }
  try {
    const notifications = await fetchFirestoreNotifications(db, uid, limit);
    return NextResponse.json({ notifications });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', details: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  let uid: string;
  try {
    uid = await authenticate(request);
  } catch (err) {
    return authErrorResponse(err);
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Internal Server Error: Firestore not initialized' },
      { status: 500 },
    );
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const col = db.collection('users').doc(uid).collection('notifications');
  const path = userNotificationsPath(uid);

  try {
    if (body?.all === true || body?.markAllRead === true) {
      // Mirror NotificationCenter.markAllPersonalRead: within its
      // loaded window, update every doc whose isRead === false.
      const current = await fetchFirestoreNotifications(db, uid, MAX_LIMIT);
      const unread = current.filter((n) => n.isRead === false);
      await Promise.all(
        unread.map(async (n) => {
          // WRITE PRIMACY (cutover W4): adapter first + throw on
          // failure under isSupaPrimary('notifications'); Firestore
          // update becomes the best-effort mirror. OFF: as before.
          if (await updateNotificationPrimaryFirst(path, n.id, { isRead: true })) {
            try {
              await col.doc(n.id).update({ isRead: true });
            } catch (e) {
              console.warn('[api/notifications] Firestore mirror after primary mark-read failed:', e);
            }
          } else {
            await col.doc(n.id).update({ isRead: true });
            await mirrorNotificationUpdate(path, n.id, { isRead: true });
          }
        }),
      );
      return NextResponse.json({ ok: true, updated: unread.length });
    }

    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) {
      return NextResponse.json(
        { error: 'Invalid request: provide { id } or { all: true }' },
        { status: 400 },
      );
    }
    try {
      // WRITE PRIMACY (cutover W4): under isSupaPrimary('notifications')
      // the adapter update lands FIRST; its failure (incl. not-found)
      // takes the same 404 as a failed Firestore update today. The
      // Firestore update then runs as the best-effort mirror.
      if (await updateNotificationPrimaryFirst(path, id, { isRead: true })) {
        try {
          await col.doc(id).update({ isRead: true });
        } catch (e) {
          console.warn('[api/notifications] Firestore mirror after primary mark-read failed:', e);
        }
      } else {
        await col.doc(id).update({ isRead: true });
        await mirrorNotificationUpdate(path, id, { isRead: true });
      }
    } catch {
      return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, updated: 1 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', details: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  let uid: string;
  try {
    uid = await authenticate(request);
  } catch (err) {
    return authErrorResponse(err);
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Internal Server Error: Firestore not initialized' },
      { status: 500 },
    );
  }

  let id = request.nextUrl.searchParams.get('id') || '';
  if (!id) {
    try {
      const body = await request.json();
      if (typeof body?.id === 'string') id = body.id;
    } catch {
      // no body — id stays empty
    }
  }
  if (!id) {
    return NextResponse.json(
      { error: 'Invalid request: provide ?id=<notificationId>' },
      { status: 400 },
    );
  }

  try {
    // WRITE PRIMACY (cutover W4): adapter first + throw on failure
    // under isSupaPrimary('notifications'); Firestore delete becomes
    // the best-effort mirror. OFF: Firestore-first + mirror.
    if (await deleteNotificationPrimaryFirst(userNotificationsPath(uid), id)) {
      try {
        await db.collection('users').doc(uid).collection('notifications').doc(id).delete();
      } catch (e) {
        console.warn('[api/notifications] Firestore mirror after primary delete failed:', e);
      }
    } else {
      await db.collection('users').doc(uid).collection('notifications').doc(id).delete();
      await mirrorNotificationDelete(userNotificationsPath(uid), id);
    }
    return NextResponse.json({ ok: true, deleted: id });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', details: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}
