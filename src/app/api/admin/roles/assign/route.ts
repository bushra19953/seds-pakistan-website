import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FOUNDER_UID } from '@/lib/roles';
import {
  assertConsentFor,
  canonicaliseRoleKey,
  consentGateHttpError,
  isCategoryBRole,
} from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/roles/assign (Phase 2, spec B.3a.1).
 *
 * The ONLY server path that writes live Category B roles. Body:
 *   { targetUid, role, reason, consentRequestId? }            - appoint/change
 *   { targetUid, action: 'revoke', reason, consentRequestId? } - strip to member
 *   { targetUid, action: 'delete', reason, consentRequestId? } - delete role profile
 *
 * Check order (spec B.2.4 conventions): authenticate -> permission -> validate
 * -> gated-ness -> assertConsentFor (LAST, it consumes) -> one batch writing
 * BOTH role stores (roles/{uid} + users/{uid} mirror) + governance audit.
 */
export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const callerUid = String((auth.user as any).userId || '');
  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageRoles'))) {
    return NextResponse.json(
      { error: 'Forbidden: role management permission required' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const targetUid = typeof body.targetUid === 'string' ? body.targetUid.trim() : '';
  const action = body.action === 'revoke' || body.action === 'delete' ? body.action : 'appoint';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const consentRequestId =
    typeof body.consentRequestId === 'string' && body.consentRequestId
      ? body.consentRequestId
      : null;

  if (!targetUid) {
    return NextResponse.json({ error: 'targetUid is required' }, { status: 400 });
  }
  if (!reason || reason.trim().length < 10) {
    return NextResponse.json(
      { error: 'A justification of at least 10 characters is required' },
      { status: 400 },
    );
  }
  // Founder immutability (mirrors role-management.ts lockdown): nobody but
  // the Founder's own session may alter the Founder's role record.
  if (targetUid === FOUNDER_UID && callerUid !== FOUNDER_UID) {
    return NextResponse.json({ error: 'The Founder role is immutable' }, { status: 403 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const targetSnap = await db.collection('users').doc(targetUid).get();
  if (!targetSnap.exists) {
    return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
  }
  const currentRoleSnap = await db.collection('roles').doc(targetUid).get();
  const currentRole = currentRoleSnap.exists
    ? canonicaliseRoleKey(String((currentRoleSnap.data() as Record<string, unknown>)?.role ?? 'member'))
    : 'member';

  let newRole = 'member';
  if (action === 'appoint') {
    if (typeof body.role !== 'string' || !body.role.trim()) {
      return NextResponse.json({ error: 'role is required' }, { status: 400 });
    }
    newRole = canonicaliseRoleKey(body.role);
    // Superadmin reservation (mirrors role-management.ts lockdown): the
    // retired token may not be handed out through this route.
    if (newRole === 'superadmin') {
      return NextResponse.json(
        { error: 'The superadmin role is reserved and cannot be assigned' },
        { status: 403 },
      );
    }
  }

  // Gated-ness is computed against BOTH the current and the new role.
  const gated =
    (await isCategoryBRole(db, currentRole)) || (await isCategoryBRole(db, newRole));

  if (gated) {
    try {
      await assertConsentFor({
        db,
        actorUid: callerUid,
        matterKey: 'catb_officer',
        consentRequestId,
        subjectRef: {
          type: 'user_role',
          targetUid,
          roleKey: action === 'appoint' ? newRole : currentRole,
          action: action === 'appoint' ? 'appoint' : 'remove',
        },
        actSummary:
          action === 'appoint'
            ? `Appoint ${targetUid} as ${newRole}`
            : `${action === 'delete' ? 'Delete role profile of' : 'Remove role from'} ${targetUid} (was ${currentRole})`,
      });
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }
  }

  // Governance audit BEFORE the write batch: per substrate contract 4, an
  // audit failure means the action fails - no half-logged role changes.
  await writeGovernanceAuditOrThrow(db, {
    action: action === 'appoint' ? 'assign_role' : action === 'delete' ? 'delete_role_profile' : 'revoke_role',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'user',
    targetId: targetUid,
    details: {
      previousRole: currentRole,
      newRole: action === 'delete' ? null : newRole,
      reason,
      consentRequestId,
      gated,
    },
  });

  const batch = db.batch();
  const rolesRef = db.collection('roles').doc(targetUid);
  const usersRef = db.collection('users').doc(targetUid);
  if (action === 'delete') {
    batch.delete(rolesRef);
    batch.set(
      usersRef,
      { role: 'member', displayRole: 'member', updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } else {
    batch.set(
      rolesRef,
      {
        role: newRole,
        grantedBy: callerUid,
        grantedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.set(
      usersRef,
      { role: newRole, displayRole: newRole, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();

  return NextResponse.json({ ok: true, role: action === 'delete' ? 'member' : newRole });
}
