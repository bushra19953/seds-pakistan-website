// POST /api/store/group-buys/[shareCode]/join - advisory join
// (PLAN-gh 3.4). Join validates and hands the buyer to checkout; it
// writes NOTHING to the team document. No seat is reserved here: the
// seat is taken at order creation through registerGroupBuySeat,
// which re-runs every check in this route inside its transaction.
// Do not "fix" this into a reservation system; the data model has
// no reservation state (PLAN-gh 1.1).
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import {
  processExpiredGroupBuy,
  resolveGroupBuyByShareCode,
} from '@/lib/server/group-buys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shareCode: string }> },
) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
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

  const { shareCode } = await params;
  const resolved = await resolveGroupBuyByShareCode(db, shareCode);
  if (!resolved) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    await processExpiredGroupBuy(db, resolved.id, { trigger: 'lazy' });
  } catch (e) {
    console.error('[group-buys] lazy expiry on join failed', e);
  }
  const fresh = await resolveGroupBuyByShareCode(db, shareCode);
  if (!fresh) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }
  const team = fresh.data;

  const reject = (code: string, message: string) =>
    NextResponse.json(
      {
        error: message,
        code,
        seatsFilled: team.memberOrderIds.length,
        teamSizeTarget: team.teamSizeTarget,
      },
      { status: 409 },
    );

  if (team.state === 'expired') {
    return reject('TEAM_EXPIRED', 'This team has expired');
  }
  if (team.state !== 'open') {
    return reject('TEAM_NOT_OPEN', 'This team is not open for joining');
  }
  if (team.memberUserIds.includes(uid)) {
    return reject('ALREADY_SEATED', 'You already have a seat in this team');
  }
  if (team.memberOrderIds.length >= team.teamSizeTarget) {
    return reject('TEAM_FULL', 'This team is full');
  }

  // The opener arriving here without a seat gets the same handoff:
  // it is his route back to his own checkout, not a second seat.
  return NextResponse.json({
    ok: true,
    groupBuyId: team.id,
    productId: team.productId,
    unitPricePkr: team.unitPricePkr,
    shareCode: team.shareCode,
    checkoutUrl: `/checkout?productId=${team.productId}&groupBuyId=${team.id}`,
  });
}
