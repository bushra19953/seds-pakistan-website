import { NextRequest, NextResponse } from 'next/server';
import { removeSeat } from '@/lib/server/governors/register';
import { SEAT_KEYS, type SeatKey } from '@/lib/governors';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
  serializeValue,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/governors/remove - Founder only (enforced in the register:
 * the recorded removal is the Founder's act, with the Board vote reference
 * carried in the note).
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateGovernorRequest(request, { edit: true });
  if ('error' in auth) return auth.error;
  const body = await request.json().catch(() => ({}));
  const seatKey = body.seatKey as SeatKey;
  if (!SEAT_KEYS.includes(seatKey)) {
    return NextResponse.json({ error: 'seatKey is required and must be a register seat' }, { status: 400 });
  }
  if (typeof body.note !== 'string' || !body.note.trim()) {
    return NextResponse.json({ error: 'note is required (state the Board vote reference)' }, { status: 400 });
  }
  if (typeof body.expectedVersion !== 'number') {
    return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });
  }
  try {
    const seat = await removeSeat(
      auth.ctx.db,
      auth.ctx.actor,
      seatKey,
      { note: body.note, expectedVersion: body.expectedVersion },
      new Date(),
    );
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
