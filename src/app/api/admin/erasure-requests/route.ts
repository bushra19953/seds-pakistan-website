import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';
import { ERASURE_PROMISE_TEXT } from '@/lib/retention/erasure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET: the admin erasure queue (Workstream F). Gated canManageUsers.
export async function GET(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user?.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const allowed = await hasServerPermission(auth.user.role, 'canManageUsers');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not initialized' },
      { status: 500 },
    );
  }
  const snap = await db
    .collection('erasure_requests')
    .orderBy('requestedAt', 'desc')
    .limit(50)
    .get();
  const requests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ requests, promise: ERASURE_PROMISE_TEXT });
}
