/**
 * POST /api/discipline/request-founder-review - a member asks the
 * Founder to review their decided case (spec E.5).
 *
 * Subject-only, decided cases only, one request per case per 30 days.
 * Creates a task for the Founder and a notification. It writes NO
 * appealStatus (the appeal field is retired vocabulary) and changes no
 * case state: the request is a request; the Founder acts through
 * /api/admin/founder-review.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';
import { createTaskForUser, notifyUser } from '@/lib/server/discipline/adapters';
import { DisciplineError, getCase } from '@/lib/server/discipline/case-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DECIDED_STATUSES = ['decided', 'board_notice_issued', 'board_vote_open', 'board_decided', 'sanction_applied', 'closed'];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        const uid = auth.user.userId;
        const body = await req.json();
        const { caseId, statement } = body || {};
        if (!caseId || !statement || !String(statement).trim()) {
            return NextResponse.json({ error: 'caseId and a statement are required' }, { status: 400 });
        }
        const kase = await getCase(db, caseId);
        if (kase.subjectUid !== uid) {
            return NextResponse.json({ error: 'Forbidden: only the case subject may request a review' }, { status: 403 });
        }
        if (!DECIDED_STATUSES.includes(kase.status)) {
            return NextResponse.json(
                { error: 'CASE_NOT_DECIDED', message: 'Founder review applies to decided cases.' },
                { status: 400 },
            );
        }
        const now = new Date();
        const last = kase.founderReviewRequests?.lastRequestAt
            ? new Date(kase.founderReviewRequests.lastRequestAt).getTime()
            : 0;
        if (last && now.getTime() - last < THIRTY_DAYS_MS) {
            return NextResponse.json(
                { error: 'REVIEW_REQUEST_TOO_SOON', message: 'A review was already requested for this case within the last 30 days.' },
                { status: 429 },
            );
        }
        await db.collection('disciplinary_cases').doc(caseId).update({
            founderReviewRequests: {
                lastRequestAt: now.toISOString(),
                requestCount: (kase.founderReviewRequests?.requestCount || 0) + 1,
            },
            updatedAt: now.toISOString(),
        });
        await createTaskForUser(db, FOUNDER_UID, {
            title: `Founder review requested - case ${kase.caseNumber}`,
            description: String(statement),
            link: `/admin/discipline/${caseId}`,
        });
        await notifyUser(FOUNDER_UID, {
            type: 'founder_review_requested',
            title: `Founder review requested - case ${kase.caseNumber}`,
            body: 'A member has requested Founder review of a decided disciplinary case.',
            link: `/admin/discipline/${caseId}`,
        });
        return NextResponse.json({ success: true });
    } catch (err: any) {
        if (err instanceof DisciplineError) {
            return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
        }
        console.error('[api/discipline/request-founder-review]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
