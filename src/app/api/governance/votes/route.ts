import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  openVote,
  VoteError,
  type VoteSubjectType,
} from '@/lib/server/governance-votes';

export const dynamic = 'force-dynamic';

function misconfigured() {
  return NextResponse.json(
    { error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' },
    { status: 500 },
  );
}

function handleError(err: unknown) {
  if (err instanceof VoteError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    );
  }
  console.error('[api/governance/votes] unexpected error', err);
  return NextResponse.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

type RequireAuthResult = { userId: string } | { error: NextResponse };

async function requireAuth(request: NextRequest): Promise<RequireAuthResult> {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return {
      error: NextResponse.json(
        { error: 'Unauthorized', code: 'UNAUTHORIZED' },
        { status: 401 },
      ),
    };
  }
  return { userId: auth.user.userId as string };
}

/**
 * POST /api/governance/votes - open a governance vote with a frozen
 * electorate snapshot (spec Section 0.2). Ballots exist only through
 * this API; client writes to governance_votes are denied in rules.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDb();
  if (!db || !ensureAdminInitialized()) return misconfigured();
  const authResult = await requireAuth(request);
  if ('error' in authResult) return authResult.error;

  let body: Record<string, any> = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON', code: 'VOTE_VALIDATION' },
      { status: 422 },
    );
  }

  try {
    const voteId = await openVote(db, {
      subjectType: body.subjectType as VoteSubjectType,
      mode: body.mode,
      electorate: body.electorate,
      createdByUid: authResult.userId,
      linkedConsentRequestId: body.linkedConsentRequestId ?? null,
      deciders: body.deciders,
      attestedBy: body.attestedBy,
      meetingRef: body.meetingRef,
      attestedResult: body.attestedResult,
    });
    return NextResponse.json({ voteId }, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
