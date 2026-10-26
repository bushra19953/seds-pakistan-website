import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  announcementsSupaServerEnabled,
  supaDeleteAnnouncement,
  supaSetAnnouncement,
  supaUpdateAnnouncement,
} from '@/lib/announcements-supa';

/**
 * POST /api/admin/announcements — WS10 primary-write route for the
 * admin announcements page (previously: client setDoc/updateDoc/
 * deleteDoc/addDoc through firestore-wrapper + raw SDK, a client
 * audit_logs write, and separate mirror route calls).
 *
 * Body: { op: 'create' | 'update' | 'delete' | 'event-update',
 *         id?, data?, timestampFields?, dateFields?,
 *         audit?: { action, target?, payload } }
 *
 * Effects per op (the page's exact effects, in its order):
 *   create: Firestore add (server-generated id) + supaSetAnnouncement
 *           mirror + audit (announcement_created).
 *   update: Firestore update + supaUpdateAnnouncement + audit when
 *           provided (announcement_updated; the toggle/priority
 *           updates pass no audit, as the page wrote none).
 *   delete: Firestore delete + supaDeleteAnnouncement + audit
 *           (announcement_deleted).
 *   event-update: Firestore-only update on events/{id} — the page's
 *           event ticker/priority writes never mirrored and never
 *           audited (the events surface owns its own mirrors).
 *
 * `timestampFields` names the client's serverTimestamp() fields:
 * real serverTimestamp on Firestore, ISO strings in the mirror
 * payload. `dateFields` names fields the page built as client
 * Timestamps (publish_date, expiresAt): the page now sends ISO
 * strings (or null); Firestore receives Admin Timestamps, the mirror
 * keeps the ISO strings — the shape the mirror seam already stored.
 * Mirrors are best-effort and gated on the announcements surface,
 * the mirror route's contract. Audit entries are written server-side
 * in logAuditEntry's stored shape, best-effort as it was.
 *
 * `announcements` and `events` are not webhook-dispatch collections,
 * so no replica effect exists for these writes.
 * Gate: verified session + canManageAnnouncements (the mirror
 * route's gate; the page's AuthorizationGate checks the same).
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
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageAnnouncements');
  } catch {
    allowed = false;
  }
  if (!allowed) return fail(403, 'Forbidden');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const op = body.op as string;
  if (!['create', 'update', 'delete', 'event-update'].includes(op)) return fail(400, 'Invalid op');
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, any>)
      : undefined;
  if (op !== 'delete' && !data) return fail(400, 'Invalid data');
  const id =
    typeof body.id === 'string' && body.id
      ? body.id
      : db.collection('announcements').doc().id;
  if (op !== 'create' && !(typeof body.id === 'string' && body.id)) {
    return fail(400, 'id is required');
  }

  const timestampFields: string[] = Array.isArray(body.timestampFields)
    ? body.timestampFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  const dateFields: string[] = Array.isArray(body.dateFields)
    ? body.dateFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  const nowIso = new Date().toISOString();
  const firestoreData: Record<string, any> = { ...(data || {}) };
  const mirrorData: Record<string, any> = { ...(data || {}) };
  for (const field of timestampFields) {
    firestoreData[field] = FieldValue.serverTimestamp();
    mirrorData[field] = nowIso;
  }
  for (const field of dateFields) {
    const v = firestoreData[field];
    if (typeof v === 'string') {
      firestoreData[field] = Timestamp.fromDate(new Date(v));
    }
  }

  try {
    if (op === 'create') {
      await db.collection('announcements').doc(id).set(firestoreData);
    } else if (op === 'update') {
      await db.collection('announcements').doc(id).update(firestoreData);
    } else if (op === 'delete') {
      await db.collection('announcements').doc(id).delete();
    } else {
      await db.collection('events').doc(id).update(firestoreData);
    }
  } catch (err) {
    console.error('[api/admin/announcements] primary write failed:', err);
    return fail(500, 'Announcement write failed');
  }

  // Audit (best-effort, logAuditEntry's contract + stored shape).
  const audit = body.audit as { action?: unknown; target?: unknown; payload?: unknown } | undefined;
  if (audit && typeof audit.action === 'string') {
    try {
      await db.collection('audit_logs').add({
        action: audit.action,
        actorUid: auth.user.userId,
        targetUidOrResource: typeof audit.target === 'string' ? audit.target : id,
        ...(audit.payload !== undefined ? { payload: audit.payload } : {}),
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('[api/admin/announcements] audit write failed (non-fatal):', err);
    }
  }

  // Mirror (best-effort; never for event-update — parity).
  if (op !== 'event-update' && announcementsSupaServerEnabled()) {
    try {
      if (op === 'delete') await supaDeleteAnnouncement(id);
      else if (op === 'update') await supaUpdateAnnouncement(id, mirrorData);
      else await supaSetAnnouncement(id, mirrorData);
    } catch (err) {
      console.error('[api/admin/announcements] mirror failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, id });
}
