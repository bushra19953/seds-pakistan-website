import { NextRequest, NextResponse } from 'next/server';
import { vacateSeat, type VacateSeatArgs } from '@/lib/server/governors/register';
import { SEAT_KEYS, type SeatKey } from '@/lib/governors';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
  serializeValue,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/admin/governors/vacate - editors only (Founder + NGS). */
export async function POST(request: NextRequest) {
  const auth = await authenticateGovernorRequest(request, { edit: true });
  if ('error' in auth) return auth.error;
  const body = await request.json().catch(() => ({}));
  const seatKey = body.seatKey as SeatKey;
  if (!SEAT_KEYS.includes(seatKey)) {
    return NextResponse.json({ error: 'seatKey is required and must be a register seat' }, { status: 400 });
  }
  const reason = body.reason as VacateSeatArgs['reason'];
  if (!['resigned', 'term_expired', 'deceased', 'other'].includes(reason)) {
    return NextResponse.json({ error: 'reason must be resigned, term_expired, deceased, or other' }, { status: 400 });
  }
  if (typeof body.expectedVersion !== 'number') {
    return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });
  }
  try {
    const seat = await vacateSeat(
      auth.ctx.db,
      auth.ctx.actor,
      seatKey,
      {
        reason,
        note: typeof body.note === 'string' ? body.note : null,
        expectedVersion: body.expectedVersion,
      },
      new Date(),
    );
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
