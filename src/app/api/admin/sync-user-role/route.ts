import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FieldValue } from 'firebase-admin/firestore';
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
 * Mirror repair ONLY (Phase 2, spec B.3a.3). roles/{uid}.role is the source of
 * truth. This route may only align users/{uid} (role + displayRole) with the
 * value roles/{uid} ALREADY holds:
 *
 * - body.role differs from roles/{uid}.role -> this would be a fresh role
 *   write, not a repair. For Category B values the consent gate runs FIRST
 *   (a hard-mode 409 wins); the route then still refuses with 409
 *   ROLE_WRITE_ROUTE_REQUIRED and directs the caller to
 *   POST /api/admin/roles/assign. Nothing is written here in that case.
 * - body.role equals roles/{uid}.role -> the mirror is written and audited
 *   as 'role_mirror_repair'.
 *
 * Note on consumption: in hard mode a gate PASS consumes the consent (spec
 * B.2 step 9 applies to every gate pass, including this probe). A caller who
 * probes this route with a valid consent and is then refused must file or
 * select a fresh consent for the assign route; that strictness is the
 * single-use rule working as specified, not a bug.
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
    return NextResponse.json({ error: 'Forbidden: role management permission required' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
  const customTitle =
    typeof body.customTitle === 'string' ? body.customTitle.trim().slice(0, 120) : undefined;
  const consentRequestId =
    typeof body.consentRequestId === 'string' && body.consentRequestId
      ? body.consentRequestId
      : null;
  if (!uid || !role) {
    return NextResponse.json({ error: 'uid and role are required' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const canonicalBodyRole = canonicaliseRoleKey(role);
  const rolesSnap = await db.collection('roles').doc(uid).get();
  const currentRole = rolesSnap.exists
    ? canonicaliseRoleKey(String((rolesSnap.data() as Record<string, unknown>)?.role ?? 'member'))
    : 'member';

  if (canonicalBodyRole !== currentRole) {
    const gated =
      (await isCategoryBRole(db, currentRole)) || (await isCategoryBRole(db, canonicalBodyRole));
    if (gated) {
      try {
        await assertConsentFor({
          db,
          actorUid: callerUid,
          matterKey: 'catb_officer',
          consentRequestId,
          subjectRef: {
            type: 'user_role',
            targetUid: uid,
            roleKey: canonicalBodyRole,
            action: 'appoint',
          },
          actSummary: `Role write attempt via sync-user-role for ${uid} (${currentRole} -> ${canonicalBodyRole})`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }
    return NextResponse.json(
      {
        error: 'ROLE_WRITE_ROUTE_REQUIRED',
        code: 'ROLE_WRITE_ROUTE_REQUIRED',
        detail:
          'sync-user-role only repairs the users mirror to the role roles/{uid} already holds. Use POST /api/admin/roles/assign for role writes.',
      },
      { status: 409 },
    );
  }

  const mirrorUpdate: Record<string, unknown> = {
    role: canonicalBodyRole,
    displayRole: canonicalBodyRole,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (customTitle !== undefined) mirrorUpdate.customTitle = customTitle;

  await writeGovernanceAuditOrThrow(db, {
    action: 'role_mirror_repair',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'user',
    targetId: uid,
    details: { role: canonicalBodyRole, consentRequestId },
  });

  await db.collection('users').doc(uid).set(mirrorUpdate, { merge: true });
  return NextResponse.json({ ok: true, uid, role: canonicalBodyRole });
}
