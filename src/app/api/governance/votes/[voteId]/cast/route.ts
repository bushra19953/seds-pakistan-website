import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { castVote, VoteError, type BallotChoice } from '@/lib/server/governance-votes';

export const dynamic = 'force-dynamic';

/**
 * POST /api/governance/votes/[voteId]/cast - cast the caller's ballot.
 * The voter must be in the vote's frozen electorate snapshot; the ballot
 * lands in ballots/{voterUid}, one per voter by construction.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ voteId: string }> },
) {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) {
    return NextResponse.json(
      { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
      { status: 500 },
    );
  }
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }
  const { voteId } = await params;
  let body: Record<string, any> = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }
  try {
    await castVote(db, voteId, auth.user.userId, body.choice as BallotChoice);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof VoteError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error('[api/governance/votes/cast] unexpected error', err);
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
