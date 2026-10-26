import { NextRequest, NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';

/**
 * POST /api/admin/seed/chapter-fee — WS10 route for the admin seed
 * page's one-shot write (previously a client setDoc through
 * firestore-wrapper): create products/chapter-fee with the page's
 * exact seed payload when it does not exist. The route re-checks
 * existence server-side, so a stale page read can never overwrite
 * the product. `products` writes from this page had no mirror (the
 * store mirrors ride /api/store/products): Firestore-only parity.
 * Gate: canManageStore (the page's AuthorizationGate).
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
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageStore');
  } catch {
    allowed = false;
  }
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const ref = db.collection('products').doc('chapter-fee');
  const snap = await ref.get();
  if (snap.exists) {
    return NextResponse.json({ ok: true, created: false });
  }
  const now = Timestamp.now();
  await ref.set({
    name: 'Chapter Registration Fee',
    description: 'Official One-Time Registration Fee for opening a SEDS Chapter.',
    price: 5000,
    currency: 'PKR',
    stock: 999999,
    category: 'other',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: 'system_seed',
  });
  return NextResponse.json({ ok: true, created: true });
}
