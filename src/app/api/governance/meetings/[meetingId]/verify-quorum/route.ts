import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  MeetingServiceError,
  QuorumForbiddenError,
  verifyQuorum,
} from '@/lib/server/governance/meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ meetingId: string }> };

/**
 * POST /api/governance/meetings/[meetingId]/verify-quorum
 * Chair only: a non-chair actor gets 403 (QuorumForbiddenError from the
 * service). Quorum not met gets 422 quorum_not_met. Success writes
 * quorumVerifiedAt/quorumVerifiedBy on the meeting and convenes it.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized', error_code: 'unauthorized' }, { status: 401 });
  }
  const actorUid = (auth.user as { userId: string }).userId;
  ensureAdminInitialized();
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized', error_code: 'db_unavailable' }, { status: 500 });
  }
  const { meetingId } = await ctx.params;
  try {
    const result = await verifyQuorum(db, { meetingId, actorUid: actorUid });
    if (!result.quorumMet) {
      return NextResponse.json(
        {
          error: 'Quorum not met',
          error_code: 'quorum_not_met',
          presentCount: result.presentCount,
          quorumRequired: result.quorumRequired,
        },
        { status: 422 },
      );
    }
    return NextResponse.json({
      meetingId: result.meetingId,
      presentCount: result.presentCount,
      quorumRequired: result.quorumRequired,
      quorumMet: true,
      quorumVerifiedAt: result.quorumVerifiedAt?.toISOString() ?? null,
      quorumVerifiedBy: result.quorumVerifiedBy,
    });
  } catch (e) {
    if (e instanceof QuorumForbiddenError) {
      return NextResponse.json({ error: e.message, error_code: e.error_code }, { status: 403 });
    }
    if (e instanceof MeetingServiceError) {
      return NextResponse.json({ error: e.message, error_code: e.error_code }, { status: e.status });
    }
    console.error('[governance/verify-quorum POST]', e);
    return NextResponse.json({ error: 'Internal error', error_code: 'internal' }, { status: 500 });
  }
}
