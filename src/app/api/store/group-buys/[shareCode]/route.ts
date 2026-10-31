// GET /api/store/group-buys/[shareCode] - public team state
// (PLAN-gh 3.3). No auth: the shareCode is a public link capability
// and the response is the minimised projection from
// buildPublicGroupBuyState only. Lazy expiry runs in claim mode
// before projecting, and a filled team gets the lazy completion
// recheck, so this response never reports a stale state.
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import {
  buildPublicGroupBuyState,
  checkAndCompleteGroupBuy,
  processExpiredGroupBuy,
  resolveGroupBuyByShareCode,
} from '@/lib/server/group-buys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ shareCode: string }> },
) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
  const { shareCode } = await params;
  const resolved = await resolveGroupBuyByShareCode(db, shareCode);
  if (!resolved) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    // Claim mode only: an anonymous read can claim expiry and cancel
    // pending orders, but it is never a money-approval maker, so no
    // refund requests are created here (PLAN-gh 6.3, C-GH-8).
    await processExpiredGroupBuy(db, resolved.id, { trigger: 'lazy' });
  } catch (e) {
    console.error('[group-buys] lazy expiry failed', e);
  }

  let fresh = await resolveGroupBuyByShareCode(db, shareCode);
  if (!fresh) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }
  if (fresh.data.state === 'filled') {
    try {
      await checkAndCompleteGroupBuy(db, fresh.id);
      fresh = (await resolveGroupBuyByShareCode(db, shareCode)) ?? fresh;
    } catch (e) {
      console.error('[group-buys] lazy completion check failed', e);
    }
  }

  const state = await buildPublicGroupBuyState(db, fresh);
  return NextResponse.json(state);
}
