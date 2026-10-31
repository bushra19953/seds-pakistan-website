import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { setReturnClaimFlag, VendorMoneyError } from '@/lib/server/vendor-money';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST: open or close a return claim on an order, flipping its
// commission entry between payable and held_dispute (GF helper).
// GG's Store Orders buttons call this route (ruling R-15). Admin
// only (canManageStore). The body carries only the claimOpen
// boolean; any other field is ignored.
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
  const body = (await request.json().catch(() => null)) as { claimOpen?: unknown } | null;
  if (!body || typeof body.claimOpen !== 'boolean') {
    return NextResponse.json({ error: 'claimOpen must be a boolean' }, { status: 400 });
  }
  try {
    const result = await setReturnClaimFlag(db, {
      orderId: params.id,
      claimOpen: body.claimOpen,
      actorUid: uid,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VendorMoneyError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.status },
      );
    }
    console.error('[admin store orders claim] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
