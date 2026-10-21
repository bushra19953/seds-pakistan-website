import { NextRequest, NextResponse } from 'next/server';
import { assignSeat, type AssignSeatArgs } from '@/lib/server/governors/register';
import { SEAT_KEYS, type ElectionResult, type SeatKey } from '@/lib/governors';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
  serializeValue,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/governors/seats/[seatKey]/assign (Phase 2, spec C.3).
 * Editors: Founder + NGS. Category evidence is validated in the register:
 * FA seats need the Founder's session + the Schedule s.3.2(b) Consent
 * (re-read server-side); co-options need the Board vote record (threshold
 * and Founder-presence lock recomputed); Member seats need the certified
 * electionResult object. Client-sent term fields are ignored.
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
  if (typeof body.holderName !== 'string' || !body.holderName.trim()) {
    return NextResponse.json({ error: 'holderName is required' }, { status: 400 });
  }
  if (typeof body.expectedVersion !== 'number') {
    return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });
  }
  const args: AssignSeatArgs = {
    holderUid: typeof body.holderUid === 'string' && body.holderUid ? body.holderUid : null,
    holderName: body.holderName,
    holderEmail: typeof body.holderEmail === 'string' ? body.holderEmail : null,
    holderExternalId: typeof body.holderExternalId === 'string' ? body.holderExternalId : null,
    publicBio: typeof body.publicBio === 'string' ? body.publicBio : null,
    photoUrl: typeof body.photoUrl === 'string' ? body.photoUrl : null,
    consentRequestId: typeof body.consentRequestId === 'string' ? body.consentRequestId : null,
    voteRecordId: typeof body.voteRecordId === 'string' ? body.voteRecordId : null,
    electionResult:
      body.electionResult && typeof body.electionResult === 'object'
        ? (body.electionResult as ElectionResult)
        : null,
    expectedVersion: body.expectedVersion,
  };
  try {
    const seat = await assignSeat(auth.ctx.db, auth.ctx.actor, seatKey, args, new Date());
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
