/**
 * GET /api/discipline/my-review - the member's own performance
 * reviews (Grove optimization item 9: appraisal).
 *
 * Mirrors /api/discipline/my-cases: authenticated self only, and a
 * strict visibility rule. A review becomes visible to the member
 * only once an officer has delivered it (deliveredAt set) - the
 * snapshot numbers and the officer's messages are the record of a
 * conversation that has happened, not a draft the member watches
 * being written. Undelivered reviews are never returned here.
 * The projection is member-safe: no other members' data, no officer
 * uids beyond the fact of delivery.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { listDeliveredReviewsForMember } from '@/lib/server/reviews/generator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
        const delivered = await listDeliveredReviewsForMember(db, uid);
        const reviews = delivered.map((r) => ({
            id: r.id,
            termKey: r.termKey,
            windowStart: r.windowStart,
            windowEnd: r.windowEnd,
            tasksApproved: r.tasksApproved,
            onTimePct: r.onTimePct,
            onTimePercentage: r.onTimePercentage,
            pointsEarned: r.pointsEarned,
            missCount: r.missCount,
            strikeCount: r.strikeCount,
            messages: r.messages,
            deliveredAt: r.deliveredAt,
            generatedAt: r.generatedAt,
        }));
        return NextResponse.json({ success: true, reviews });
    } catch (err: any) {
        console.error('[api/discipline/my-review]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
