import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FieldValue } from 'firebase-admin/firestore';
import {
  effectiveRoleOf,
  isCatalogRoleKey,
  isReservedTitle,
  CUSTOM_TITLE_MAX_LENGTH,
  type CatalogRoleKey,
} from '@/lib/role-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Custom-title endpoint + mirror repair (Phase 1, spec B.2 item 2).
 *
 * This route NO LONGER sets roles. Role changes go through
 * POST /api/admin/roles/write (the single write path). It honors:
 * - customTitle: always, after reserved-title and length validation.
 * - role / displayRole / additionalRoles: ONLY when they exactly equal
 *   the effective role computed from the roles/{uid} doc (a repair write,
 *   equivalent to setMirror). A divergent role field is rejected 409:
 *   silently mirroring an arbitrary role is how the stores diverged.
 */
export async function POST(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageRoles'))) {
    return NextResponse.json({ error: 'Forbidden: role management permission required' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
  if (!uid) {
    return NextResponse.json({ error: 'uid is required' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (typeof body.customTitle === 'string') {
    const customTitle = body.customTitle.trim();
    if (customTitle.length > CUSTOM_TITLE_MAX_LENGTH) {
      return NextResponse.json(
        { error: `customTitle exceeds ${CUSTOM_TITLE_MAX_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (customTitle && isReservedTitle(customTitle)) {
      return NextResponse.json(
        { error: 'customTitle uses a reserved office title' },
        { status: 400 },
      );
    }
    update.customTitle = customTitle;
  }

  const wantsRoleMirror =
    typeof body.role === 'string' || typeof body.displayRole === 'string' || body.additionalRoles !== undefined;
  if (wantsRoleMirror) {
    const roleSnap = await db.collection('roles').doc(uid).get();
    if (!roleSnap.exists) {
      return NextResponse.json(
        { error: 'No roles record exists for this user; role changes go through /api/admin/roles/write', code: 'no_roles_record' },
        { status: 409 },
      );
    }
    const data = roleSnap.data() as Record<string, unknown>;
    const primary = data.role as CatalogRoleKey;
    const additional = Array.isArray(data.additionalRoles)
      ? (data.additionalRoles as CatalogRoleKey[])
      : [];
    if (!isCatalogRoleKey(primary)) {
      return NextResponse.json(
        { error: 'Stored roles record holds a non-catalog role; repair it through reconciliation', code: 'non_catalog_role' },
        { status: 409 },
      );
    }
    const effective = effectiveRoleOf(primary, additional);
    const requestedRole = typeof body.role === 'string' ? body.role.trim().toLowerCase() : effective;
    const requestedDisplay =
      typeof body.displayRole === 'string' ? body.displayRole.trim().toLowerCase() : effective;
    if (requestedRole !== effective || requestedDisplay !== effective) {
      return NextResponse.json(
        {
          error: 'Requested mirror does not match the roles record; role changes go through /api/admin/roles/write',
          code: 'mirror_mismatch',
          effectiveRole: effective,
        },
        { status: 409 },
      );
    }
    update.role = effective;
    update.displayRole = effective;
    update.roleSource = 'roles';
    if (additional.length > 0) update.additionalRoles = additional;
    else update.additionalRoles = FieldValue.delete();
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  await db.collection('users').doc(uid).set(update, { merge: true });
  return NextResponse.json({ ok: true, uid });
}
