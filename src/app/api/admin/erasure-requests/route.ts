import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { ERASURE_PROMISE_TEXT } from '@/lib/retention/erasure';
import { retentionConsentData } from '@/lib/retention/supa-seam';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET: the admin erasure queue (Workstream F). Gated canManageUsers.
export async function GET(request: NextRequest) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user?.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const allowed = await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageUsers');
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
  // Seam (cutover; residual compliance consumer #2): the admin queue
  // list reads through retentionConsentData.listErasureRequests when
  // the 'erasure-consent' surface is enabled (same orderBy/limit —
  // the seam mirrors them exactly). An adapter error falls back to
  // the Firestore query below, per the seam's gate rule; flag OFF
  // never consults the seam. (The permission gate above stays on
  // Firestore — identity cluster.)
  if (retentionConsentData.enabled()) {
    try {
      const requests = await retentionConsentData.listErasureRequests(50);
      return NextResponse.json({ requests, promise: ERASURE_PROMISE_TEXT });
    } catch {
      // fall through to the Firestore read
    }
  }
  const snap = await db
    .collection('erasure_requests')
    .orderBy('requestedAt', 'desc')
    .limit(50)
    .get();
  const requests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ requests, promise: ERASURE_PROMISE_TEXT });
}
