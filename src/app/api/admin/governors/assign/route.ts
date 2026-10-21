import { NextRequest, NextResponse } from 'next/server';
import { assignSeat, type AssignSeatArgs } from '@/lib/server/governors/register';
import { SEAT_KEYS, type SeatKey } from '@/lib/governors';
import {
  authenticateGovernorRequest,
  governorErrorResponse,
  serializeValue,
} from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/governors/assign (Phase 2, spec C.3).
 * Editors: Founder + NGS. Category rules are enforced in the register:
 * FA seats need the Founder + a Schedule Consent reference (a consent ID,
 * NOT the Section B picker - FA consent is a different matter class);
 * co-options need the vote record or the declared Quorum Lock; Member seats
 * need the certified general-meeting result.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateGovernorRequest(request, { edit: true });
  if ('error' in auth) return auth.error;
  const body = await request.json().catch(() => ({}));
  const seatKey = body.seatKey as SeatKey;
  if (!SEAT_KEYS.includes(seatKey)) {
    return NextResponse.json({ error: 'seatKey is required and must be a register seat' }, { status: 400 });
  }
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
    electionMeetingDate: typeof body.electionMeetingDate === 'string' ? body.electionMeetingDate : null,
    electionVotesFor: typeof body.electionVotesFor === 'number' ? body.electionVotesFor : null,
    electionVotesCast: typeof body.electionVotesCast === 'number' ? body.electionVotesCast : null,
    electionQuorumMet: typeof body.electionQuorumMet === 'boolean' ? body.electionQuorumMet : null,
    founderQuorumLock: body.founderQuorumLock === true,
    expectedVersion: body.expectedVersion,
  };
  try {
    const seat = await assignSeat(auth.ctx.db, auth.ctx.actor, seatKey, args, new Date());
    return NextResponse.json({ ok: true, seat: serializeValue(seat) });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
