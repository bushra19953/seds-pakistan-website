import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { mirrorTimelineDelete, mirrorTimelineDoc } from '@/lib/supa-timeline/mirror-timeline';

/**
 * POST /api/admin/pages/write — WS10 route for the client-direct
 * writes to the `pages` and `timeline` collections:
 *   - admin/pages (set-merge saves, incl. the donate page's
 *     non-destination fields — the dual-record destination flow
 *     itself already goes through /api/admin/finance/approvals and
 *     is untouched),
 *   - admin/pages/contact (set),
 *   - admin/legal-documents (set on pages/{docId}),
 *   - admin/timeline (set-merge save + delete).
 *
 * Body: { collection: 'pages' | 'timeline', op: 'set' | 'delete',
 *         id?, data?, merge?, timestampFields?, dateFields? } —
 * the same stamp/convert protocol as the other WS10 write routes.
 * Neither collection is a webhook-dispatch collection. Timeline
 * writes additionally mirror to fs_timeline (2026-11-01, the
 * timeline Supabase seam): after a successful Firestore set/delete
 * the stored doc is mirrored through mirror-timeline.ts, which is
 * best-effort and never fails the write — drift is repaired by the
 * daily resync guard (/api/cron/resync-timeline). Pages writes stay
 * Firestore-only: the pages collection has no public read seam.
 * Gates: pages → canManagePages or canManagePermissions (the three
 * pages' gates: pages + contact use canManagePages, legal-documents
 * uses canManagePermissions); timeline → canManageTimeline.
 */

export const dynamic = 'force-dynamic';

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) return fail(500, 'Server misconfiguration');
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return fail(401, 'Unauthorized');
  const db = getDb();
  if (!db) return fail(500, 'Server misconfiguration');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const collection = body.collection === 'timeline' ? 'timeline' : body.collection === 'pages' ? 'pages' : '';
  if (!collection) return fail(400, 'Invalid collection');

  const permissions =
    collection === 'timeline' ? ['canManageTimeline'] : ['canManagePages', 'canManagePermissions'];
  let allowed = false;
  for (const permission of permissions) {
    try {
      if (await hasServerPermissionForUser(db as never, auth.user.userId, permission as never)) {
        allowed = true;
        break;
      }
    } catch {
      /* try the next gate */
    }
  }
  if (!allowed) return fail(403, 'Forbidden');

  const op = body.op === 'delete' ? 'delete' : body.op === 'set' ? 'set' : '';
  if (!op) return fail(400, 'Invalid op');
  const id =
    typeof body.id === 'string' && body.id ? body.id : db.collection(collection).doc().id;
  if (op === 'delete' && !(typeof body.id === 'string' && body.id)) {
    return fail(400, 'id is required');
  }

  if (op === 'delete') {
    await db.collection(collection).doc(id).delete();
    if (collection === 'timeline') {
      const mirror = await mirrorTimelineDelete(id);
      if (mirror === 'failed') {
        console.error(`[api/admin/pages/write] timeline mirror delete failed for ${id}; resync guard will repair`);
      }
    }
    return NextResponse.json({ ok: true, id });
  }

  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, any>)
      : null;
  if (!data) return fail(400, 'Invalid data');
  const firestoreData: Record<string, any> = { ...data };
  const timestampFields: string[] = Array.isArray(body.timestampFields)
    ? body.timestampFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  for (const field of timestampFields) {
    firestoreData[field] = FieldValue.serverTimestamp();
  }
  const dateFields: string[] = Array.isArray(body.dateFields)
    ? body.dateFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  for (const field of dateFields) {
    if (typeof firestoreData[field] === 'string') {
      firestoreData[field] = Timestamp.fromDate(new Date(firestoreData[field]));
    }
  }

  try {
    if (body.merge === true) {
      await db.collection(collection).doc(id).set(firestoreData, { merge: true });
    } else {
      await db.collection(collection).doc(id).set(firestoreData);
    }
  } catch (err) {
    console.error('[api/admin/pages/write] write failed:', err);
    return fail(500, 'Write failed');
  }
  if (collection === 'timeline') {
    // Mirror the STORED doc (re-read: serverTimestamp stamps and
    // merge results are only final in the stored form). One read per
    // admin write; the mirror itself never fails the write.
    try {
      const stored = await db.collection(collection).doc(id).get();
      const mirror = await mirrorTimelineDoc(
        id,
        stored.exists ? (stored.data() as Record<string, unknown>) : null,
      );
      if (mirror === 'failed') {
        console.error(`[api/admin/pages/write] timeline mirror failed for ${id}; resync guard will repair`);
      }
    } catch (err) {
      console.error(`[api/admin/pages/write] timeline mirror re-read failed for ${id}:`, err);
    }
  }
  return NextResponse.json({ ok: true, id });
}
