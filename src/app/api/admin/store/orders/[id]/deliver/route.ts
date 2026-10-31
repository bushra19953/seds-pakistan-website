import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { deliverVendorOrder, VendorMoneyError } from '@/lib/server/vendor-delivery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST: mark a shipped vendor order delivered, with the commission,
// escrow, and late credit effects in deliverVendorOrder (GF, R-9).
// Admin only (canManageStore, same gate as the orders route). The
// route accepts no body: delivery time and every money value come
// from server documents and the server clock.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const canManage = await hasServerPermissionForUser(db, uid, 'canManageStore');
  if (!canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const result = await deliverVendorOrder(db, { orderId: params.id, actorUid: uid });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VendorMoneyError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.status },
      );
    }
    console.error('[admin store orders deliver] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
