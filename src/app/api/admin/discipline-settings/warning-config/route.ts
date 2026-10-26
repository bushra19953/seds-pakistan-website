import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';

/**
 * PUT /api/admin/discipline-settings/warning-config — WS10 route
 * for the discipline settings panel's legacy warning-config write
 * (previously a client setDoc merge on warningConfig/global through
 * firestore-wrapper; `warningConfig` is not a webhook-dispatch
 * collection and has no Supabase mirror — Firestore-only parity).
 *
 * NOT the same doc as PUT /api/admin/discipline-settings, which
 * writes settings/discipline for the newer discipline form; this
 * route exists so the legacy form's write is server-side too.
 * Body { form } — the panel's exact payload; the route stamps
 * updatedAt server-side. Gate: canManageUsers (the panel's own
 * handleSave gate).
 */

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
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
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageUsers');
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
  const form =
    body.form && typeof body.form === 'object' && !Array.isArray(body.form)
      ? (body.form as Record<string, any>)
      : null;
  if (!form) return NextResponse.json({ error: 'Invalid form' }, { status: 400 });

  await db.collection('warningConfig').doc('global').set(
    { ...form, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return NextResponse.json({ ok: true });
}
