/**
 * /api/discipline/cases/[caseId]/board - the Strike 3 Board flow
 * (spec E.3.7-E.3.10, E.4.4).
 *
 * Actions: issue-board-notice (NGS), open-vote (NGS or Founder; the
 * state machine rejects opens before boardVoteOpensAt with 409
 * BOARD_NOTICE_PERIOD - Z-13: no override, no Founder exception),
 * cast-ballot (Governors in the frozen snapshot), close-vote.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { DisciplineError, getCase, transitionCase } from '@/lib/server/discipline/case-service';
import { resolveActorOffices } from '@/lib/server/discipline/adapters';
import { castBallot, closeExpulsionVote, openExpulsionVote } from '@/lib/server/discipline/vote-adapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function errorResponse(err: any) {
    if (err instanceof DisciplineError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[api/discipline/board]', err);
    return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
}

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        const actor = await resolveActorOffices(db, auth.user.userId);
        const body = await req.json();
        const action = body?.action as string;
        const now = new Date();
        const kase = await getCase(db, params.caseId);

        if (action === 'issue-board-notice') {
            const updated = await transitionCase(db, params.caseId, 'board_notice_issued', actor, { note: body.note }, now);
            return NextResponse.json({ success: true, case: updated });
        }
        if (action === 'open-vote') {
            // transitionCase enforces the 7-day notice period and the
            // seated-Board check before any vote doc exists.
            await transitionCase(db, params.caseId, 'board_vote_open', actor, { note: body.note }, now);
            const voteId = await openExpulsionVote(db, params.caseId, now);
            return NextResponse.json({ success: true, voteId });
        }
        if (action === 'cast-ballot') {
            const voteId = kase.boardVoteId || body.voteId;
            if (!voteId) return NextResponse.json({ error: 'No vote is open for this case' }, { status: 400 });
            if (body.choice !== 'for' && body.choice !== 'against' && body.choice !== 'abstain') {
                return NextResponse.json({ error: 'choice must be for, against, or abstain' }, { status: 400 });
            }
            await castBallot(db, voteId, actor.uid, body.choice);
            return NextResponse.json({ success: true });
        }
        if (action === 'close-vote') {
            const voteId = kase.boardVoteId || body.voteId;
            if (!voteId) return NextResponse.json({ error: 'No vote exists for this case' }, { status: 400 });
            const result = await closeExpulsionVote(db, voteId, actor, now);
            return NextResponse.json({ success: true, ...result });
        }
        return NextResponse.json({ error: 'UNKNOWN_ACTION', message: `Unknown action ${action}` }, { status: 400 });
    } catch (err: any) {
        return errorResponse(err);
    }
}
