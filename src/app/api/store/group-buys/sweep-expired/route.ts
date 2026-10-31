// POST /api/store/group-buys/sweep-expired - expiry sweep (R-15,
// PLAN-gh 3.7 / 6.4). GG's "Sweep expired teams" button calls this
// with the admin's Bearer token.
//
// Auth, either: (a) a canManageStore holder's Bearer token; that
// admin is the maker for the refund requests the sweep creates
// (full mode), or (b) a CRON_SECRET bearer via isCronRequest; cron
// runs claim mode only (no maker exists), and the summary reports
// teamsAwaitingRefundRequests until an admin sweep completes them.
// Unauthenticated: 401. Signed in without the permission and
// without cron auth: 403, and the sweep does not run.
//
// Routing note: sweep-expired is a static segment sibling of
// [shareCode]; Next.js prefers the static segment, and no valid
// shareCode can equal it (the Crockford alphabet has no lowercase
// and no hyphen).
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser, resolveUserRole } from '@/lib/server/permissions';
import { isCronRequest } from '@/lib/server/cron-auth';
import { sweepExpiredGroupBuys } from '@/lib/server/group-buys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');

  let maker: { uid: string; role: string } | undefined;
  if (!isCronRequest(authHeader, process.env.CRON_SECRET)) {
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
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const role = await resolveUserRole(db, uid);
    maker = { uid, role: role ?? 'store_admin' };
  }

  let limit: number | undefined;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body.limit === 'number') limit = body.limit;
  } catch {
    // A body is optional on this route; an unreadable one is ignored.
  }

  const summary = await sweepExpiredGroupBuys(db, { maker, limit });
  return NextResponse.json({
    ok: true,
    scanned: summary.scanned,
    claimed: summary.claimed,
    cancelledOrders: summary.cancelledOrders,
    refundApprovalsCreated: summary.refundApprovalsCreated,
    teamsAwaitingRefundRequests: summary.teamsAwaitingRefundRequests,
    inTransitOrders: summary.inTransitOrders,
    errors: summary.errors,
  });
}
