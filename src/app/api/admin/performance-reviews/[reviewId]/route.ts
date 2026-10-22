/**
 * /api/admin/performance-reviews/[reviewId] - one review doc
 * (Grove optimization item 9: appraisal).
 *
 * reviewId is the deterministic doc id `{subjectUid}_{termKey}`.
 * PATCH is the officer edit surface the design pins here: it may
 * change `messages` and `deliveredAt` only, through the generator's
 * applyReviewUpdate, which rejects a delivery while messages is
 * empty (Grove's order: conclusions before delivery). GET returns
 * the single review under the same read gate as the list route
 * (Records variant gate + entitled offices + chapter scoping).
 *
 * Identity falls back to the body and query string when the route
 * param is unavailable, so the handler stays total: every failure is
 * a JSON status, never a throw.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { isFounderUid, resolveActorOffices } from '@/lib/server/discipline/adapters';
import { getDisciplineSettings } from '@/lib/server/discipline/settings';
import { applyReviewUpdate, getPerformanceReview } from '@/lib/server/reviews/generator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VIEWER_OFFICES = ['ngs', 'audit_chair', 'membership_director', 'chapter_president'];

function callerRole(auth: any): string {
    return (auth.user as any).role || '';
}

function callerUid(auth: any): string {
    return String((auth.user as any).userId || (auth.user as any).uid || '');
}

async function reviewIdFrom(req: NextRequest, context: any): Promise<string> {
    try {
        const params = context?.params ? await context.params : null;
        if (params && typeof params.reviewId === 'string' && params.reviewId) return params.reviewId;
    } catch {
        // fall through to the path
    }
    const segments = req.nextUrl.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
}

function splitReviewId(reviewId: string): { subjectUid: string; term: string } {
    const idx = reviewId.indexOf('_');
    if (idx <= 0) return { subjectUid: '', term: '' };
    return { subjectUid: reviewId.slice(0, idx), term: reviewId.slice(idx + 1) };
}

function identityFrom(req: NextRequest, body: any, fallbackId: string): { subjectUid: string; term: string } {
    const params = req.nextUrl.searchParams;
    const fromId = splitReviewId(fallbackId);
    const subjectUid = (
        (typeof body?.subjectUid === 'string' ? body.subjectUid : '') ||
        (typeof body?.uid === 'string' ? body.uid : '') ||
        (typeof body?.memberUid === 'string' ? body.memberUid : '') ||
        params.get('subjectUid') ||
        params.get('uid') ||
        fromId.subjectUid ||
        ''
    ).trim();
    const term = (
        (typeof body?.term === 'string' ? body.term : '') ||
        (typeof body?.termKey === 'string' ? body.termKey : '') ||
        (typeof body?.quarterKey === 'string' ? body.quarterKey : '') ||
        params.get('term') ||
        params.get('termKey') ||
        fromId.term ||
        ''
    ).trim();
    return { subjectUid, term };
}

export async function GET(req: NextRequest, context: any) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const settings = await getDisciplineSettings(db);
        if (settings.warningRegistryVariant !== 'internal') {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
        const actor = await resolveActorOffices(db, auth.user.userId);
        const entitled = isFounderUid(actor.uid) || actor.offices.some((o) => VIEWER_OFFICES.includes(o));
        if (!entitled) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const reviewId = await reviewIdFrom(req, context);
        const { subjectUid, term } = identityFrom(req, null, reviewId);
        if (!subjectUid || !term) {
            return NextResponse.json({ error: 'Bad request', message: 'A review id is required' }, { status: 400 });
        }
        const review = await getPerformanceReview(db, subjectUid, term);
        if (review && !isFounderUid(actor.uid) && actor.offices.length === 1 && actor.offices[0] === 'chapter_president') {
            const userSnap = await db.collection('users').doc(subjectUid).get();
            const chapterId = userSnap.exists ? (userSnap.data() || {}).chapterId || null : null;
            if (chapterId !== actor.chapterId) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }
        return NextResponse.json({ success: true, term, review });
    } catch (err: any) {
        console.error('[api/admin/performance-reviews/[reviewId] GET]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest, context: any) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (!(await hasServerPermission(callerRole(auth), 'canManageUsers'))) {
            return NextResponse.json(
                { error: 'Forbidden: Insufficient permissions to manage performance reviews' },
                { status: 403 },
            );
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const body = await req.json().catch(() => null);
        const reviewId = await reviewIdFrom(req, context);
        const { subjectUid, term } = identityFrom(req, body, reviewId);
        if (!subjectUid || !term) {
            return NextResponse.json(
                { error: 'Bad request', message: 'subjectUid and term are required' },
                { status: 400 },
            );
        }
        if (!body || (body.messages === undefined && body.delivered === undefined && body.deliveredAt === undefined)) {
            return NextResponse.json(
                { error: 'Bad request', message: 'Nothing to update: send messages and/or deliveredAt' },
                { status: 400 },
            );
        }

        const result = await applyReviewUpdate(db, {
            subjectUid,
            termKey: term,
            messages: typeof body.messages === 'string' ? body.messages : undefined,
            delivered: typeof body.delivered === 'boolean' ? body.delivered : undefined,
            deliveredAt: body.deliveredAt === undefined ? undefined : body.deliveredAt,
            actorUid: callerUid(auth),
        });
        if (!result.ok) {
            return NextResponse.json({ error: 'Bad request', message: result.message }, { status: result.status });
        }
        return NextResponse.json({ success: true, review: result.review });
    } catch (err: any) {
        console.error('[api/admin/performance-reviews/[reviewId] PATCH]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
