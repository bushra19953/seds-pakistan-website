import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { mirrorSettingsDoc } from '@/lib/server/settings-mirror';

/**
 * POST /api/admin/site-settings/write — WS10 primary-write route for
 * the two client-direct settings writes:
 *
 *   { op: 'set' | 'update', payload } — settings/siteWide, from
 *   site-settings-management (create-default setDoc + save
 *   updateDoc). The route stamps updatedAt (serverTimestamp on
 *   Firestore) and then mirrors through mirrorSettingsDoc — the
 *   mirror the component used to fire-and-forget through
 *   /api/admin/site-settings/mirror after its client write.
 *
 *   { op: 'certificate', payload, audit } — settings/
 *   certificate_product set-merge, from the store page's
 *   certificate-settings component, plus its money-audit entry
 *   ('store_settings_updated', logAuditEntry's stored shape with
 *   { before, after, changedFields }). The component SURFACES an
 *   audit failure with a distinct toast, so the route reports
 *   { auditWritten } instead of hiding it. No mirror: the client
 *   write never mirrored this doc (the settings mirror's documented
 *   scope is settings/discipline + settings/siteWide), and adding
 *   one is a read-model change, not a conversion.
 *
 * Gate: verified session + canManageUsers (the mirror route's gate;
 * the store page's own authorization is the same cluster).
 * `settings` writes are not webhook-dispatch writes: no replica
 * effect.
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
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageUsers');
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
  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, any>)
      : null;
  if (!payload) return fail(400, 'Invalid payload');

  if (body.op === 'set' || body.op === 'update') {
    const nowIso = new Date().toISOString();
    const ref = db.collection('settings').doc('siteWide');
    try {
      if (body.op === 'set') {
        await ref.set({ ...payload, updatedAt: FieldValue.serverTimestamp() });
      } else {
        await ref.update({ ...payload, updatedAt: FieldValue.serverTimestamp() });
      }
    } catch (err) {
      console.error('[api/admin/site-settings/write] siteWide write failed:', err);
      return fail(500, 'Settings write failed');
    }
    await mirrorSettingsDoc('settings', 'siteWide', { ...payload, updatedAt: nowIso });
    return NextResponse.json({ ok: true });
  }

  if (body.op === 'certificate') {
    try {
      await db.collection('settings').doc('certificate_product').set(payload, { merge: true });
    } catch (err) {
      console.error('[api/admin/site-settings/write] certificate write failed:', err);
      return fail(500, 'Settings write failed');
    }
    let auditWritten = false;
    const audit = body.audit as Record<string, any> | undefined;
    if (audit && typeof audit === 'object') {
      try {
        await db.collection('audit_logs').add({
          action: 'store_settings_updated',
          actorUid: auth.user.userId,
          targetUidOrResource: 'settings/certificate_product',
          payload: {
            before: audit.before ?? null,
            after: audit.after ?? null,
            changedFields: Array.isArray(audit.changedFields) ? audit.changedFields : [],
          },
          timestamp: FieldValue.serverTimestamp(),
        });
        auditWritten = true;
      } catch (err) {
        console.error('[api/admin/site-settings/write] audit write failed:', err);
      }
    }
    return NextResponse.json({ ok: true, auditWritten });
  }

  return fail(400, 'Invalid op');
}
