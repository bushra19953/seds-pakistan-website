// H-09 (FOUNDER_ACCESS_MAP_2026-10-25): governance votes family has NO permission gate by faithful-migration design — any authenticated user can open a vote with a body-supplied electorate and closeVote performs no actor check. DO NOT add a gate in migration work; the fix is a separate, founder-decided change.
import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { closeVote, VoteError } from '@/lib/server/governance-votes';
import { resolveVotesDb } from '@/lib/server/governance/motions-supa';

export const dynamic = 'force-dynamic';

/**
 * POST /api/governance/votes/[voteId]/close - close the vote and certify
 * the result. Idempotent: a second close returns the stored result.
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
  try {
    const result = await closeVote(resolveVotesDb() as never, voteId, auth.user.userId);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof VoteError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error('[api/governance/votes/close] unexpected error', err);
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
