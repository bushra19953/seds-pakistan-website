import { NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { GOVERNORS_COLLECTION, SEAT_KEYS, SEAT_ORDER, type GovernorSeat } from '@/lib/governors';
import { toPublicSeat } from '@/lib/board-public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
};

/**
 * GET /api/board (Phase 2, spec C.3) - the public Board projection.
 * Seated seats only, allow-list fields only, seatOrder order. While the
 * boardLive flag is off the endpoint answers 200 with an empty board so the
 * About component renders nothing without an error state.
 */
export async function GET() {
  ensureAdminInitialized();
  const db = getDb();
  if (!db) {
    return NextResponse.json({ boardLive: false, board: [] });
  }
  const live = await isPhase2Live(db as never, 'boardLive');
  if (!live) {
    return NextResponse.json({ boardLive: false, board: [] });
  }
  const snap = await db.collection(GOVERNORS_COLLECTION).get();
  const byKey = new Map<string, GovernorSeat>();
  snap.docs.forEach((d) => byKey.set(d.id, d.data() as GovernorSeat));
  const now = new Date();
  const board = SEAT_KEYS.map((key) => byKey.get(key))
    .filter((seat): seat is GovernorSeat => seat != null)
    .sort((a, b) => (a.seatOrder ?? SEAT_ORDER[a.seatKey]) - (b.seatOrder ?? SEAT_ORDER[b.seatKey]))
    .map((seat) => toPublicSeat(seat, now))
    .filter((seat) => seat != null);
  return NextResponse.json({ boardLive: true, board }, { headers: CACHE_HEADERS });
}
