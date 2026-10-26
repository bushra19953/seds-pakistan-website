import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { mirrorDocUpdate, mirrorDocWrite } from '@/lib/supa-events/server-events';

/**
 * POST /api/admin/events/write — WS10 primary-write route for the
 * event doc writes that were client-direct:
 *   - admin events new page (op 'set' + the product-link 'update'),
 *   - admin events edit page (op 'update': save, product-link,
 *     soft-delete),
 *   - public events/new page draft create (op 'create').
 *
 * Body: { op: 'set' | 'update' | 'create', id?, data,
 *         timestampFields?, millisFields?, dateFields? }
 * `timestampFields` names the pages' serverTimestamp() fields
 * (serverTimestamp on Firestore, ISO in the mirror);
 * `millisFields` maps field → epoch millis (the pages' startAt /
 * endAt, built with Timestamp.fromMillis) or null to skip;
 * `dateFields` names ISO-string fields Firestore stores as
 * Timestamps (the public draft's `date`).
 *
 * Firestore primary; the mirror follows through the supa-events
 * seam (mirrorDocWrite / mirrorDocUpdate — the same helpers the
 * events publish route uses; both no-op when the surface is off and
 * never throw). Before WS10 these page writes had NO mirror at all.
 * Events doc writes are not webhook-dispatch writes (`events` is
 * not a dispatch collection): no replica effect.
 *
 * Gate: verified session + canManageEvents. NOTE for the public
 * draft create: the page gated on the chair_events role client-side;
 * this route gates on the canManageEvents permission — the standard
 * server mapping for that role. Flagged in the WS10 report as the
 * one gate-equivalence assumption in this group.
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
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageEvents');
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
  if (!['set', 'update', 'create'].includes(op)) return fail(400, 'Invalid op');
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, any>)
      : null;
  if (!data) return fail(400, 'Invalid data');
  const id =
    typeof body.id === 'string' && body.id ? body.id : db.collection('events').doc().id;
  if (op !== 'create' && !(typeof body.id === 'string' && body.id)) {
    return fail(400, 'id is required');
  }

  const nowIso = new Date().toISOString();
  const firestoreData: Record<string, any> = { ...data };
  const mirrorData: Record<string, any> = { ...data };
  const timestampFields: string[] = Array.isArray(body.timestampFields)
    ? body.timestampFields.filter((f: unknown): f is string => typeof f === 'string')
    : [];
  for (const field of timestampFields) {
    firestoreData[field] = FieldValue.serverTimestamp();
    mirrorData[field] = nowIso;
  }
  const millisFields =
    body.millisFields && typeof body.millisFields === 'object' && !Array.isArray(body.millisFields)
      ? (body.millisFields as Record<string, unknown>)
      : {};
  for (const [field, ms] of Object.entries(millisFields)) {
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      firestoreData[field] = Timestamp.fromMillis(ms);
      mirrorData[field] = new Date(ms).toISOString();
    } else {
      delete firestoreData[field];
      delete mirrorData[field];
    }
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
    if (op === 'update') {
      await db.collection('events').doc(id).update(firestoreData);
    } else {
      await db.collection('events').doc(id).set(firestoreData);
    }
  } catch (err) {
    console.error('[api/admin/events/write] primary write failed:', err);
    return fail(500, 'Event write failed');
  }

  if (op === 'update') {
    await mirrorDocUpdate('events', id, mirrorData);
  } else {
    await mirrorDocWrite('events', id, mirrorData);
  }

  return NextResponse.json({ ok: true, id });
}
