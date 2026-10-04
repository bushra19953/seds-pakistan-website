import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-side mirror for users/{uid}.role + displayRole.
 * Client-side writes to users/{uid} can be denied by Firestore rules
 * (the role-management carve-out historically excluded 'role', and the
 * numeric-fields validity check fails on docs missing those fields), so the
 * client role manager falls back to this route. The Admin SDK bypasses rules.
 * roles/{uid}.role remains the source of truth; this only repairs the mirror.
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
  const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
  if (!uid || !role) {
    return NextResponse.json({ error: 'uid and role are required' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  await db.collection('users').doc(uid).set(
    { role, displayRole: role, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return NextResponse.json({ ok: true, uid, role });
}
