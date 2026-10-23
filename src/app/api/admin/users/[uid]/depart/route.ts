import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  departUser,
  InvalidMemberTransitionError,
  MemberNotFoundError,
} from '@/lib/server/member-lifecycle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST: mark a member Departed (soft delete).
 * Replaces the retired DELETE /api/admin/hierarchy/user hard delete (D1).
 * The user doc is retained; see src/lib/server/member-lifecycle.ts.
 * Gate: canManageUsers, same mechanism as the hierarchy user route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { uid: string } }
) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!(await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageUsers'))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    const { uid } = params;
    if (!uid) {
      return NextResponse.json({ error: 'User id is required' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    // Same minimum as the retired nuclear path: a real justification.
    if (!reason || reason.trim().length < 10) {
      return NextResponse.json(
        { error: 'A reason of at least 10 characters is required' },
        { status: 400 }
      );
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB failed');

    const result = await departUser(db, uid, auth.user.userId, reason.trim());
    return NextResponse.json({ success: true, uid, memberStatus: result.memberStatus });
  } catch (e) {
    if (e instanceof MemberNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (e instanceof InvalidMemberTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('[users/depart] error:', e);
    return NextResponse.json({ error: 'Failed to mark member departed' }, { status: 500 });
  }
}
