import { NextRequest, NextResponse } from 'next/server';
import { updateSeatNotes } from '@/lib/server/governors/register';
import { SEAT_KEYS, type SeatKey } from '@/lib/governors';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
  serializeValue,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/admin/governors/seats/[seatKey]/notes - editors only. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ seatKey: string }> },
) {
  const auth = await authenticateGovernorRequest(request, { edit: true });
  if ('error' in auth) return auth.error;
  const { seatKey: rawSeatKey } = await params;
  const seatKey = rawSeatKey as SeatKey;
  if (!SEAT_KEYS.includes(seatKey)) {
    return NextResponse.json({ error: 'Unknown seat', code: 'SEAT_NOT_FOUND' }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  if (typeof body.expectedVersion !== 'number') {
    return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });
  }
  try {
    const seat = await updateSeatNotes(
      auth.ctx.db,
      auth.ctx.actor,
      seatKey,
      typeof body.notes === 'string' ? body.notes : null,
      body.expectedVersion,
    );
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
