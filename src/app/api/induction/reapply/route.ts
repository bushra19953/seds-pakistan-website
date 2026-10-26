import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

/**
 * POST /api/induction/reapply — WS10 route for the induction page's
 * re-apply flag clear (previously a direct-SDK updateDoc on
 * users/{uid}; no wrapper, so no dispatch and no replica effect).
 *
 * The client write relied on the firestore.rules isOwnReapply path:
 * owner only, the stored users doc's applicationStatus must be
 * 'rejected', and only {hasApplied, applicationStatus, updatedAt}
 * may change (flag → false, status → null). The Admin SDK bypasses
 * rules, so this route enforces the same guard server-side: the
 * caller is the token UID (no body input at all), the stored status
 * is read first, and anything other than 'rejected' returns
 * 403 { error: 'permission-denied' } — the exact signal the page's
 * catch maps to its "only rejected applications" message.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  const uid = auth.user.userId;

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists || snap.data()?.applicationStatus !== 'rejected') {
    return NextResponse.json({ error: 'permission-denied' }, { status: 403 });
  }

  try {
    await userRef.update({
      hasApplied: false,
      applicationStatus: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[api/induction/reapply] flag clear failed:', err);
    return NextResponse.json({ error: 'Re-apply failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
