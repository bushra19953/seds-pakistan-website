import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  reinstateUser,
  InvalidMemberTransitionError,
  MemberNotFoundError,
} from '@/lib/server/member-lifecycle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST: reinstate a Departed member back to active.
 * Positions ended at departure are NOT auto-restored (see
 * src/lib/server/member-lifecycle.ts reinstateUser).
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

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB failed');

    const result = await reinstateUser(db, uid, auth.user.userId);
    return NextResponse.json({ success: true, uid, memberStatus: result.memberStatus });
  } catch (e) {
    if (e instanceof MemberNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (e instanceof InvalidMemberTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('[users/reinstate] error:', e);
    return NextResponse.json({ error: 'Failed to reinstate member' }, { status: 500 });
  }
}
