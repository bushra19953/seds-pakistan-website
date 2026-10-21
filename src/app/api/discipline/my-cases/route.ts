/**
 * GET /api/discipline/my-cases - the member's own disciplinary record
 * (spec E.8).
 *
 * Shows ONLY cases the member has been told about: status from
 * notice_issued onward. Drafts (notice_draft), un-noticed cases
 * (initiated), and the member's deadline miss records are NEVER shown -
 * a draft is not a case against the member until a notice is served.
 * The projection is member-safe: no hearing notes, no drafter notes, no
 * other members' data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HIDDEN_STATUSES = ['initiated', 'notice_draft'];

export async function GET(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        const uid = auth.user.userId;
        const snap = await db
            .collection('disciplinary_cases')
            .where('subjectUid', '==', uid)
            .get();
        const cases: any[] = [];
        snap.forEach((d: any) => {
            const c = d.data() || {};
            if (HIDDEN_STATUSES.includes(c.status)) return;
            cases.push({
                caseId: d.id,
                caseNumber: c.caseNumber,
                status: c.status,
                constitutionalGround: c.constitutionalGround,
                groundNarrative: c.groundNarrative,
                noticeText: c.noticeText,
                noticeIssuedAt: c.noticeIssuedAt,
                defenceDueAt: c.defenceDueAt,
                defenceText: c.defenceText,
                defenceReceivedAt: c.defenceReceivedAt,
                defenceLate: c.defenceLate,
                decision: c.decision,
                decisionReason: c.decisionReason,
                strikeNumber: c.strikeNumber,
                suspensionEndsAt: c.suspensionEndsAt,
                conditions: c.conditions,
                boardVoteId: c.sanctionApplied?.banVoteId || c.boardVoteId || null,
                founderReview: c.founderReview
                    ? {
                          outcome: c.founderReview.outcome,
                          at: c.founderReview.at,
                          noticeText: c.founderReview.noticeText,
                      }
                    : null,
                founderReviewRequests: c.founderReviewRequests || { lastRequestAt: null, requestCount: 0 },
                decidedAt: c.decidedAt,
                closedAt: c.closedAt,
            });
        });
        cases.sort((a, b) => String(b.noticeIssuedAt || '').localeCompare(String(a.noticeIssuedAt || '')));
        return NextResponse.json({ success: true, cases });
    } catch (err: any) {
        console.error('[api/discipline/my-cases]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
