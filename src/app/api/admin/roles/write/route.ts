import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { isFounderUid } from '@/config/founder';
import {
  assignRole,
  removeRole,
  RoleWriteError,
  type RoleWriteSource,
} from '@/lib/server/role-writes';
import {
  assertConsentFor,
  canonicaliseRoleKey,
  consentGateHttpError,
  isCategoryBRole,
} from '@/lib/server/consent-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/roles/write (Phase 1, spec B.2 item 1).
 *
 * The single role-change endpoint. The actor is resolved from the
 * authenticated profile via the Admin SDK, never trusted from the body.
 * Actor authorization: the Founder, or a holder of canManageRoles reached
 * through the mirror role; R5/R4 grants additionally require the Founder
 * (enforced inside assignRole as well).
 *
 * Body:
 *   { action: 'assign', uid, role, additionalRoles?, chapterId?, reason, idempotencyKey? }
 *   { action: 'remove', uid, reason, idempotencyKey? }
 *   { action: 'set-custom-title', uid, customTitle }  -> 410 (use sync-user-role)
 */
export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const actorUid = String((auth.user as { uid?: string }).uid || '');
  if (!actorUid) {
    return NextResponse.json({ error: 'Actor could not be resolved' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'set-custom-title') {
    return NextResponse.json(
      { error: 'customTitle is not a role change; use POST /api/admin/sync-user-role' },
      { status: 410 },
    );
  }
  if (action !== 'assign' && action !== 'remove') {
    return NextResponse.json({ error: 'action must be "assign" or "remove"' }, { status: 400 });
  }

  // Actor authorization via the Admin-SDK mirror profile.
  if (!isFounderUid(actorUid)) {
    const actorSnap = await db.collection('users').doc(actorUid).get();
    const actorRole = String(actorSnap.data()?.role || '');
    if (!(await hasServerPermission(actorRole, 'canManageRoles'))) {
      return NextResponse.json(
        { error: 'Forbidden: role management permission required' },
        { status: 403 },
      );
    }
  }

  const uid = typeof body.uid === 'string' ? body.uid.trim() : '';

  // Founder immutability (moved from the retired verbatim-write route
  // /api/admin/roles/assign, which enforced it at its :71-75): nobody but
  // the Founder's own session may alter the Founder's role record, by
  // assign or by remove. Placed BEFORE the consent gate (which consumes
  // consents in hard mode) so a refused founder write never burns one.
  // role-writes' validateActorForRole gates the GRANTED role only; this
  // is the server-side protection for the Founder's OWN record.
  if (isFounderUid(uid) && !isFounderUid(actorUid)) {
    return NextResponse.json(
      { error: 'The Founder role is immutable' },
      { status: 403 },
    );
  }

  const reason = typeof body.reason === 'string' ? body.reason : '';
  const source: RoleWriteSource =
    body.source === 'authority_inspector' || body.source === 'superadmin_page'
      ? body.source
      : 'admin_ui';
  const idempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

  // Phase 2 consent gate (integration step 4): Category B appointments
  // and removals are Reserved Matters. The gate is enforced HERE, at the
  // single write path, so no caller (UI, inspector, or direct API) can
  // bypass it - the gates crew's per-route interceptions on the legacy
  // routes remain as second layers. In record mode the gate passes with
  // a warning stamp; in hard mode a decided consent is required and a
  // pass consumes it (single-use).
  try {
    const gateRoleKey =
      action === 'assign'
        ? canonicaliseRoleKey(typeof body.role === 'string' ? body.role : '')
        : canonicaliseRoleKey(
            String(
              (await db.collection('roles').doc(uid).get()).data()?.role || '',
            ),
          );
    if (gateRoleKey && (await isCategoryBRole(db, gateRoleKey))) {
      try {
        await assertConsentFor({
          db,
          actorUid,
          matterKey: 'catb_officer',
          consentRequestId:
            typeof body.consentRequestId === 'string' ? body.consentRequestId : null,
          subjectRef: {
            type: 'user_role',
            targetUid: uid,
            roleKey: gateRoleKey,
            action: action === 'assign' ? 'appoint' : 'remove',
          },
          actSummary:
            action === 'assign'
              ? `Appoint ${uid} to ${gateRoleKey} (roles/write)`
              : `Remove ${uid} from ${gateRoleKey} (roles/write)`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }
  } catch (err) {
    console.error('[roles/write] consent gate check failed:', err);
    return NextResponse.json({ error: 'Consent gate check failed' }, { status: 500 });
  }

  try {
    if (action === 'assign') {
      // Grant expiry passthrough (contracts 3.2; expiry-core E2): an ISO
      // string becomes a Date, JSON null stays null (explicit clear),
      // absent stays undefined (preserve). An unparseable string is
      // passed through as an Invalid Date ON PURPOSE: role-writes is
      // the single validation point and rejects it as invalid_expiry.
      const expiresAtRaw: unknown = body.expiresAt;
      const expiresAt =
        typeof expiresAtRaw === 'string'
          ? new Date(expiresAtRaw)
          : expiresAtRaw === null
            ? null
            : undefined;
      const expiresRoleKey =
        typeof body.expiresRoleKey === 'string' ? body.expiresRoleKey : undefined;
      const result = await assignRole(db, {
        uid,
        role: body.role,
        additionalRoles: Array.isArray(body.additionalRoles) ? body.additionalRoles : undefined,
        chapterId: typeof body.chapterId === 'string' ? body.chapterId : undefined,
        actorUid,
        reason,
        source,
        idempotencyKey,
        expiresAt,
        expiresRoleKey,
      });
      const stamped = result.roleDoc.expiresAt;
      const expiresAtIso =
        stamped instanceof Date
          ? stamped.toISOString()
          : stamped &&
              typeof stamped === 'object' &&
              typeof (stamped as { toDate?: unknown }).toDate === 'function'
            ? (stamped as { toDate: () => Date }).toDate().toISOString()
            : null;
      return NextResponse.json({
        ok: true,
        uid,
        effectiveRole: result.newEffectiveRole,
        alreadyApplied: result.alreadyApplied,
        expiresAt: expiresAtIso,
      });
    }
    const result = await removeRole(db, {
      uid,
      actorUid,
      reason,
      source,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      uid,
      previousEffectiveRole: result.previousEffectiveRole,
      alreadyApplied: result.alreadyApplied,
    });
  } catch (err) {
    if (err instanceof RoleWriteError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    console.error('[roles/write] unexpected error:', err);
    return NextResponse.json({ error: 'Role write failed' }, { status: 500 });
  }
}
