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
 * POST /api/admin/governors/seats/[seatKey]/remove (Phase 2, spec C.3).
 * Body { removalRecord: { cause, causeDetail, noticeDate, replyRef,
 * voteRecordId, effectiveAt }, expectedVersion }. Founder-Appointed seats:
 * Founder only, cause founder_discretion. Co-opted / Member-Elected: a
 * passing Board removal vote, validated in the register.
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
  if (typeof body.expectedVersion !== 'number') {
    return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });
  }
  const rr = (body.removalRecord ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  try {
    const seat = await removeSeat(
      auth.ctx.db,
      auth.ctx.actor,
      seatKey,
      {
        removal: {
          cause: str(rr.cause),
          causeDetail: str(rr.causeDetail),
          noticeDate: str(rr.noticeDate),
          replyRef: str(rr.replyRef),
          voteRecordId: str(rr.voteRecordId),
          effectiveAt: str(rr.effectiveAt),
        },
        expectedVersion: body.expectedVersion,
      },
      new Date(),
    );
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
