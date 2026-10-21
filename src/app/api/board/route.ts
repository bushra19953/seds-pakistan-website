import { NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { GOVERNORS_COLLECTION, SEAT_KEYS, seatCategory, type GovernorSeat } from '@/lib/governors';
import { toPublicSeat, vacantPublicSeat } from '@/lib/board-public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/board (Phase 2, spec C.4) - the public Board projection.
 * Allow-list output only (see src/lib/board-public.ts). While the boardLive
 * flag is off the endpoint answers 200 with an empty board so the About page
 * can mount unconditionally and render nothing.
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
  const board = SEAT_KEYS.map((key) => {
    const seat = byKey.get(key);
    return seat ? toPublicSeat(seat, now) : vacantPublicSeat(key, seatCategory(key));
  });
  return NextResponse.json({ boardLive: true, board });
}
