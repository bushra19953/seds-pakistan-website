import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';

/**
 * POST /api/admin/applications/induction-form — WS10 route for the
 * induction form editor's write (previously a client setDoc on
 * settings/induction_form through firestore-wrapper + a client
 * audit entry).
 *
 * Effects: Admin set (NO merge — the editor replaces the doc) with
 * { fields, updatedAt: serverTimestamp, updatedBy: callerUid },
 * then the 'induction_form_updated' audit entry in logAuditEntry's
 * stored shape ({ fieldCount }), best-effort as logAuditEntry is.
 * `settings` is not a webhook-dispatch collection and this doc has
 * no Supabase mirror: no replica effect, Firestore-only parity.
 * Gate: canManageApplications (the parent admin page's gate).
 * Body: { fields: unknown[] }.
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
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageApplications');
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
  if (!Array.isArray(body.fields)) {
    return NextResponse.json({ error: 'fields is required' }, { status: 400 });
  }

  try {
    await db.collection('settings').doc('induction_form').set({
      fields: body.fields,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.user.userId,
    });
  } catch (err) {
    console.error('[api/admin/applications/induction-form] write failed:', err);
    return NextResponse.json({ error: 'Failed to save form configuration' }, { status: 500 });
  }

  try {
    await db.collection('audit_logs').add({
      action: 'induction_form_updated',
      actorUid: auth.user.userId,
      targetUidOrResource: 'settings/induction_form',
      payload: { fieldCount: body.fields.length },
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('Audit logging failed (non-fatal):', err);
  }

  return NextResponse.json({ ok: true });
}
