import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FOUNDER_UID } from '@/lib/roles';
import { isCatalogRoleKey, type CatalogRoleKey } from '@/lib/role-catalog';
import {
  assignRole,
  removeRole,
  RoleWriteError,
} from '@/lib/server/role-writes';
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
 * POST /api/admin/roles/assign (Phase 2, spec B.3a.1) - FOLDED into the
 * single write path (Custom Roles Fix Program, contracts section 3.3).
 *
 * The request/response envelope is unchanged for compatibility:
 *   { targetUid, role, reason, consentRequestId? }            - appoint/change
 *   { targetUid, action: 'revoke', reason, consentRequestId? } - strip to member
 *   { targetUid, action: 'delete', reason, consentRequestId? } - delete role profile
 *
 * But NO write is performed by this route itself: the verbatim batch
 * write that used to set roles/{uid} and the users/{uid} mirror from
 * the request body is deleted. Every action executes through
 * assignRole / removeRole in src/lib/server/role-writes.ts, so role
 * validation, additionalRoles, chapter handling, roleHistory,
 * audit_logs and the authority_refresh signal all come from the one
 * gated path. Consequences, intended by the fold:
 *   - an invented or junk slug fails role-writes validation
 *     (unknown_role, 400) instead of being stored verbatim;
 *   - a custom_ slug is translated like the users-table pick: the
 *     primary stays the holder's current catalog primary (or
 *     member_basic when no roles doc exists) and the custom slug is
 *     appended to additionalRoles - custom roles never occupy the
 *     primary slot (contracts section 2.1);
 *   - 'delete' now lands the mirror on member_basic (removeRole
 *     semantics, the Phase 1 floor) where the old verbatim write
 *     claimed 'member'.
 *
 * Check order (spec B.2.4 conventions, unchanged): authenticate ->
 * permission -> validate -> founder immutability -> gated-ness ->
 * assertConsentFor (LAST, it consumes) -> governance audit -> the
 * role-writes call.
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
  // the Founder's own session may alter the Founder's role record. The
  // same guard now also stands in POST /api/admin/roles/write.
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
  const currentData = currentRoleSnap.exists
    ? (currentRoleSnap.data() as Record<string, unknown>)
    : null;
  const currentPrimaryRaw =
    typeof currentData?.role === 'string' ? currentData.role : null;
  const currentRole = currentPrimaryRaw
    ? canonicaliseRoleKey(currentPrimaryRaw)
    : 'member';
  const currentAdditional: string[] = Array.isArray(currentData?.additionalRoles)
    ? (currentData.additionalRoles as unknown[]).filter(
        (r): r is string => typeof r === 'string',
      )
    : [];

  // Translate the request into a role-writes call. NOTHING is validated
  // here beyond the reserved-token check the old route always made:
  // catalog membership, custom-definition validity and chapter match
  // are role-writes' job (contracts sections 3.2/3.3), and its
  // RoleWriteError is surfaced to the caller unchanged.
  let gateNewRole = 'member';
  let appointPlan: { role: string; additionalRoles: string[] } | null = null;
  if (action === 'appoint') {
    if (typeof body.role !== 'string' || !body.role.trim()) {
      return NextResponse.json({ error: 'role is required' }, { status: 400 });
    }
    const requested = body.role.trim();
    if (requested.startsWith('custom_')) {
      // Custom roles live ONLY in additionalRoles (contracts 2.1): the
      // primary stays the holder's current catalog primary, or the
      // member_basic floor when they hold no roles doc yet.
      const primary =
        currentPrimaryRaw && isCatalogRoleKey(currentPrimaryRaw)
          ? currentPrimaryRaw
          : 'member_basic';
      appointPlan = {
        role: primary,
        additionalRoles: Array.from(new Set([...currentAdditional, requested])),
      };
      gateNewRole = requested;
    } else {
      const newRole = canonicaliseRoleKey(requested);
      // Superadmin reservation (mirrors role-management.ts lockdown): the
      // retired token may not be handed out through this route.
      if (newRole === 'superadmin') {
        return NextResponse.json(
          { error: 'The superadmin role is reserved and cannot be assigned' },
          { status: 403 },
        );
      }
      // Existing additionalRoles pass through untouched: assignRole
      // replaces the additional set, and the old route's merge write
      // left it intact.
      appointPlan = { role: newRole, additionalRoles: currentAdditional };
      gateNewRole = newRole;
    }
  }

  // Gated-ness is computed against BOTH the current and the new role
  // (preserved from the pre-fold route; the roles/write route gates on
  // the new role only - that asymmetry is dependency D-1 in the
  // side-door plan, flagged for governance ratification, not silently
  // harmonised here).
  const gated =
    (await isCategoryBRole(db, currentRole)) || (await isCategoryBRole(db, gateNewRole));

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
          roleKey: action === 'appoint' ? gateNewRole : currentRole,
          action: action === 'appoint' ? 'appoint' : 'remove',
        },
        actSummary:
          action === 'appoint'
            ? `Appoint ${targetUid} as ${gateNewRole}`
            : `${action === 'delete' ? 'Delete role profile of' : 'Remove role from'} ${targetUid} (was ${currentRole})`,
      });
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }
  }

  // Governance audit BEFORE the write: per substrate contract 4, an
  // audit failure means the action fails - no half-logged role changes.
  // (role-writes adds its own roleHistory + audit_logs role_change
  // entries inside the write itself.)
  await writeGovernanceAuditOrThrow(db, {
    action: action === 'appoint' ? 'assign_role' : action === 'delete' ? 'delete_role_profile' : 'revoke_role',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'user',
    targetId: targetUid,
    details: {
      previousRole: currentRole,
      newRole: action === 'delete' ? null : gateNewRole,
      reason,
      consentRequestId,
      gated,
    },
  });

  try {
    if (action === 'delete') {
      await removeRole(db, {
        uid: targetUid,
        actorUid: callerUid,
        reason,
        source: 'admin_ui',
      });
      // removeRole floors the mirror at member_basic (Phase 1 floor);
      // the response reports the actual resulting role.
      return NextResponse.json({ ok: true, role: 'member_basic' });
    }
    const plan =
      action === 'revoke'
        ? // Revoke strips the appointment AND any additional grants:
          // the holder lands on plain 'member', as the old route did.
          { role: 'member', additionalRoles: [] as string[] }
        : appointPlan!;
    const result = await assignRole(db, {
      uid: targetUid,
      role: plan.role as CatalogRoleKey,
      additionalRoles: plan.additionalRoles as CatalogRoleKey[],
      actorUid: callerUid,
      reason,
      source: 'admin_ui',
      consentRequestId,
    });
    return NextResponse.json({ ok: true, role: result.newEffectiveRole });
  } catch (err) {
    if (err instanceof RoleWriteError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    console.error('[roles/assign] role-writes delegation failed:', err);
    return NextResponse.json({ error: 'Role assignment failed' }, { status: 500 });
  }
}
