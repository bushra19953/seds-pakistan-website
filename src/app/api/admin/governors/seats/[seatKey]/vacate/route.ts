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

/**
 * POST /api/admin/governors/seats/[seatKey]/vacate (Phase 2, spec C.3).
 * Founder or NGS. Body { reason, detail, recordRef?, markAwaitingElection?,
 * expectedVersion }.
 */
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
  const reason = body.reason as VacateSeatArgs['reason'];
  if (!['resigned', 'deceased', 'incapacitated', 'other'].includes(reason)) {
    return NextResponse.json(
      { error: 'reason must be resigned, deceased, incapacitated, or other' },
      { status: 400 },
    );
  }
  if (typeof body.detail !== 'string' || !body.detail.trim()) {
    return NextResponse.json({ error: 'detail is required' }, { status: 400 });
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
        detail: body.detail,
        recordRef: typeof body.recordRef === 'string' ? body.recordRef : null,
        markAwaitingElection: body.markAwaitingElection === true,
        expectedVersion: body.expectedVersion,
      },
      new Date(),
    );
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
