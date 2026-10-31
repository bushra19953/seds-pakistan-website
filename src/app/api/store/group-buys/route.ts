// POST /api/store/group-buys - open a group buy team (PLAN-gh 3.2).
// Auth: Bearer token, the products-route pattern. The body is an
// allowlist of one field, productId; price, target, window, share
// code, opener and state are all server-derived (mass assignment
// guard). The opener's seat is NOT taken here: it is taken when his
// checkout order is created (seat contract, PLAN-gh 4).
import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { createGroupBuyTeam, GroupBuyError } from '@/lib/server/group-buys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
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

  let productId: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    productId = body?.productId;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof productId !== 'string' || !productId) {
    return NextResponse.json({ error: 'productId is required' }, { status: 400 });
  }

  try {
    const { groupBuyId, shareCode, team } = await createGroupBuyTeam(db, {
      openerUserId: uid,
      productId,
    });
    return NextResponse.json(
      {
        ok: true,
        groupBuyId,
        shareCode,
        teamUrl: `/group-buy/${shareCode}`,
        checkout: { productId, groupBuyId },
        expiresAt: (team.expiresAt as { toDate?: () => Date })?.toDate?.()?.toISOString() ?? null,
        unitPricePkr: team.unitPricePkr,
        teamSizeTarget: team.teamSizeTarget,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof GroupBuyError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.error('[group-buys] create failed', e);
    return NextResponse.json({ error: 'Could not open the team' }, { status: 500 });
  }
}
