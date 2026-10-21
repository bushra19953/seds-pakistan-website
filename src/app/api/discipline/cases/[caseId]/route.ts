/**
 * /api/discipline/cases/[caseId] - read one case + fire state-machine
 * transitions (issue-notice, submit-defence, open-hearing, dismiss).
 * Decisions do NOT live here: they run through the decide sub-route
 * (applyCaseDecision). Board flow lives in the board sub-route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
    DisciplineError,
    DisciplinaryCase,
    getCase,
    recordHearingOutcome,
    transitionCase,
} from '@/lib/server/discipline/case-service';
import { isFounderUid, resolveActorOffices } from '@/lib/server/discipline/adapters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function errorResponse(err: any) {
    if (err instanceof DisciplineError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[api/discipline/cases/[caseId]]', err);
    return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
}

function canReadCase(actorOffices: string[], actorUid: string, kase: DisciplinaryCase): boolean {
    if (actorUid === kase.subjectUid) return true;
    if (isFounderUid(actorUid)) return true;
    if (actorOffices.includes('ngs') || actorOffices.includes('audit_chair')) return true;
    // Decided outcomes are visible to the issuer roles named in E.4.
    const decided = ['decided', 'board_notice_issued', 'board_vote_open', 'board_decided', 'sanction_applied', 'closed', 'decided_outcome_failed'].includes(kase.status);
    if (decided && (actorOffices.includes('chapter_president') || actorOffices.includes('membership_director') || actorOffices.includes('nec'))) {
        return true;
    }
    if (actorUid === kase.initiatedByUid) return true;
    return false;
}

export async function GET(req: NextRequest, { params }: { params: { caseId: string } }) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        const actor = await resolveActorOffices(db, auth.user.userId);
        const kase = await getCase(db, params.caseId);
        if (!canReadCase(actor.offices, actor.uid, kase)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        // The subject never sees drafts, hearing notes, or referral internals.
        if (actor.uid === kase.subjectUid && !isFounderUid(actor.uid)) {
            const { hearingNotes, drafterNote, ...safe } = kase as any;
            return NextResponse.json({ success: true, case: safe });
        }
        return NextResponse.json({ success: true, case: kase });
    } catch (err: any) {
        return errorResponse(err);
    }
}

const ACTION_TO_STATUS: Record<string, string> = {
    'issue-notice': 'notice_issued',
    'submit-defence': 'defence_received',
    'open-hearing': 'hearing',
    dismiss: 'dismissed',
};

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
        if (action === 'record-hearing-outcome') {
            const updated = await recordHearingOutcome(db, params.caseId, actor, {
                hearingOutcome: body.hearingOutcome,
                hearingNotes: body.hearingNotes || '',
            }, new Date());
            return NextResponse.json({ success: true, case: updated });
        }
        const to = ACTION_TO_STATUS[action];
        if (!to) {
            return NextResponse.json({ error: 'UNKNOWN_ACTION', message: `Unknown action ${action}` }, { status: 400 });
        }
        const updated = await transitionCase(db, params.caseId, to as any, actor, {
            note: body.note,
            noticeText: body.noticeText,
            noticeChannel: body.noticeChannel,
            defenceText: body.defenceText,
            hearingAt: body.hearingAt,
            hearingNotes: body.hearingNotes,
            decisionReason: body.decisionReason,
            ngsVacant: body.ngsVacant === true,
        }, new Date());
        return NextResponse.json({ success: true, case: updated });
    } catch (err: any) {
        return errorResponse(err);
    }
}
