import { NextRequest, NextResponse } from 'next/server';

// Force Node runtime so firebase-admin works reliably.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifySession, toSessionErrorResponse } from '@/lib/auth/verifySession';
import { getAuctionLot } from '@/types/auction';

/**
 * POST /api/events/auction/bid
 * Places a bid on a donated hardware auction lot.
 *
 * Body: { eventId: string, lotId: string, amount: number, bidderName?: string }
 *
 * Rules:
 * - 401 when the Authorization: Bearer <token> session is missing or invalid.
 * - 400 when the bid is below the lot's mandatory reserve price floor.
 * - 201 with the bid record when accepted. Proceeds are 100 percent net
 *   operating margin ($0 COGS: every lot is donated).
 */
export async function POST(request: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json(
      { error: 'Server misconfiguration: Firebase Admin not initialized' },
      { status: 500 }
    );
  }

  let decoded;
  try {
    decoded = await verifySession(request);
  } catch (err) {
    const sessionErr = toSessionErrorResponse(err);
    if (sessionErr) return sessionErr;
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { eventId?: string; lotId?: string; amount?: number; bidderName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { eventId, lotId, amount, bidderName } = body;

  if (!eventId || typeof eventId !== 'string') {
    return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
  }
  if (!lotId || typeof lotId !== 'string') {
    return NextResponse.json({ error: 'lotId is required' }, { status: 400 });
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
  }

  // Resolve the lot from the static catalog and enforce the reserve floor.
  const lot = getAuctionLot(lotId);
  if (!lot) {
    return NextResponse.json({ error: 'Unknown auction lot' }, { status: 400 });
  }
  if (amount < lot.reservePrice) {
    return NextResponse.json(
      {
        error: `Bid rejected: amount ${amount} is below the reserve price floor of ${lot.reservePrice} ${lot.currency}`,
        reservePrice: lot.reservePrice,
        currency: lot.currency,
      },
      { status: 400 }
    );
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore unavailable' }, { status: 500 });
  }

  const bidRef = db.collection('auction_bids').doc();
  const bid = {
    lotId: lot.id,
    eventId,
    bidderUid: decoded.uid,
    bidderName: bidderName?.trim() || decoded.name || decoded.email || 'Anonymous bidder',
    amount,
    currency: lot.currency,
    meetsReserve: true,
    // $0 COGS model: donated lot, so the full amount is net operating margin.
    netMargin: amount,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await bidRef.set(bid);
  } catch (e) {
    console.error('[auction/bid] Failed to write bid', { error: (e as Error)?.message });
    return NextResponse.json({ error: 'Failed to record bid' }, { status: 500 });
  }

  return NextResponse.json(
    {
      success: true,
      bidId: bidRef.id,
      lotId: lot.id,
      amount,
      currency: lot.currency,
    },
    { status: 201 }
  );
}
