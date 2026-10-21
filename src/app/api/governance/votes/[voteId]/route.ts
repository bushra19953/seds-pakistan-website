import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getVote, VoteError } from '@/lib/server/governance-votes';

export const dynamic = 'force-dynamic';

/**
 * GET /api/governance/votes/[voteId] - the vote record and its certified
 * result. Individual ballots are never exposed (ballotCount only).
 */
export async function GET(
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
  try {
    const vote = await getVote(db, voteId);
    return NextResponse.json({ vote });
  } catch (err) {
    if (err instanceof VoteError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error('[api/governance/votes/[voteId]] unexpected error', err);
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
