/**
 * /api/admin/performance-reviews - performance review records
 * (Grove optimization item 9: appraisal).
 *
 * One Review per member per fiscal quarter, generated server-side
 * from tasks, points_ledger, deadline miss records, and decided
 * discipline cases (see src/lib/server/reviews/generator.ts). The
 * `performance_reviews` collection is server-only: this route and
 * its [reviewId] sibling are the officers' only read/write surface,
 * and members read their own delivered reviews through
 * /api/discipline/my-review. No client touches the collection
 * directly, so no Firestore rule change is needed.
 *
 * Gates:
 *  - GET follows the performance-records pattern exactly: the
 *    Records tab variant gate (404 unless settings/discipline
 *    selects the 'internal' variant), then entitled offices only
 *    (ngs, audit_chair, membership_director, chapter_president, or
 *    the Founder), with chapter presidents scoped to their own
 *    chapter server-side.
 *  - POST (generate/regenerate) and PUT (messages / deliveredAt)
 *    require canManageUsers, the write gate of
 *    PUT /api/admin/discipline-settings.
 *
 * The one ordering rule (Grove: conclusions before delivery):
 * deliveredAt can only stand while messages is non-empty; the
 * generator's applyReviewUpdate rejects any write whose final state
 * would break that.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounderUid, resolveActorOffices } from '@/lib/server/discipline/adapters';
import { getDisciplineSettings } from '@/lib/server/discipline/settings';
import { quarterKeyOf } from '@/lib/server/compliance/report-aggregator';
import {
    applyReviewUpdate,
    generatePerformanceReview,
    getPerformanceReview,
    isValidReviewTermKey,
    listPerformanceReviews,
    type PerformanceReview,
} from '@/lib/server/reviews/generator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VIEWER_OFFICES = ['ngs', 'audit_chair', 'membership_director', 'chapter_president'];

function callerRole(auth: any): string {
    return (auth.user as any).role || '';
}

function callerUid(auth: any): string {
    return String((auth.user as any).userId || (auth.user as any).uid || '');
}

function stepBackQuarter(key: string): string {
    const m = /^FY(\d{2})-Q([1-4])$/.exec(key);
    if (!m) return key;
    let fy = Number(m[1]);
    let q = Number(m[2]) - 1;
    if (q === 0) {
        q = 4;
        fy -= 1;
    }
    return `FY${String(fy).padStart(2, '0')}-Q${q}`;
}

/** Current fiscal quarter plus the previous ones, newest first. */
function recentQuarterKeys(count: number): string[] {
    const keys: string[] = [];
    let key = quarterKeyOf(new Date());
    for (let i = 0; i < count; i++) {
        keys.push(key);
        key = stepBackQuarter(key);
    }
    return keys;
}

async function requireReadAccess(
    req: NextRequest,
): Promise<
    | { ok: true; db: any; actorUid: string; ownChapterOnly: string | null }
    | { ok: false; res: NextResponse }
> {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
        return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
        return { ok: false, res: NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 }) };
    }
    const settings = await getDisciplineSettings(db);
    if (settings.warningRegistryVariant !== 'internal') {
        return { ok: false, res: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
    }
    const actor = await resolveActorOffices(db, auth.user.userId);
    const entitled = isFounderUid(actor.uid) || actor.offices.some((o) => VIEWER_OFFICES.includes(o));
    if (!entitled) {
        return { ok: false, res: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    const ownChapterOnly =
        !isFounderUid(actor.uid) && actor.offices.length === 1 && actor.offices[0] === 'chapter_president'
            ? actor.chapterId
            : null;
    return { ok: true, db, actorUid: auth.user.userId, ownChapterOnly };
}

async function requireWriteAccess(
    req: NextRequest,
): Promise<{ ok: true; db: any; actorUid: string } | { ok: false; res: NextResponse }> {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
        return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    if (!(await hasServerPermissionForUser(getDb() as never, callerUid(auth), 'canManageUsers'))) {
        return {
            ok: false,
            res: NextResponse.json(
                { error: 'Forbidden: Insufficient permissions to manage performance reviews' },
                { status: 403 },
            ),
        };
    }
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
        return { ok: false, res: NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 }) };
    }
    return { ok: true, db, actorUid: callerUid(auth) };
}

function termFrom(params: URLSearchParams, body: any): string {
    return (
        params.get('term') ||
        params.get('termKey') ||
        params.get('quarterKey') ||
        (typeof body?.term === 'string' ? body.term : '') ||
        (typeof body?.termKey === 'string' ? body.termKey : '') ||
        (typeof body?.quarterKey === 'string' ? body.quarterKey : '') ||
        ''
    );
}

function subjectFrom(params: URLSearchParams, body: any): string {
    return (
        params.get('subjectUid') ||
        params.get('uid') ||
        (typeof body?.subjectUid === 'string' ? body.subjectUid : '') ||
        (typeof body?.uid === 'string' ? body.uid : '') ||
        (typeof body?.memberUid === 'string' ? body.memberUid : '') ||
        ''
    ).trim();
}

/** Last-resort identity: a trailing `{subjectUid}_{termKey}` path segment. */
function identityFromPath(req: NextRequest): { subjectUid: string; term: string } {
    const segments = req.nextUrl.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    const idx = last.indexOf('_');
    if (idx <= 0) return { subjectUid: '', term: '' };
    return { subjectUid: last.slice(0, idx), term: last.slice(idx + 1) };
}

export async function GET(req: NextRequest) {
    try {
        const access = await requireReadAccess(req);
        if (!access.ok) return access.res;
        const { db, ownChapterOnly } = access;
        const params = req.nextUrl.searchParams;
        const term = termFrom(params, null) || quarterKeyOf(new Date());
        const subjectUid = subjectFrom(params, null);

        if (subjectUid) {
            const review = await getPerformanceReview(db, subjectUid, term);
            if (review && ownChapterOnly) {
                const userSnap = await db.collection('users').doc(subjectUid).get();
                const chapterId = userSnap.exists ? (userSnap.data() || {}).chapterId || null : null;
                if (chapterId !== ownChapterOnly) {
                    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
                }
            }
            return NextResponse.json({ success: true, term, terms: recentQuarterKeys(4), review });
        }

        let reviews = await listPerformanceReviews(db, term);
        if (ownChapterOnly) {
            const filtered: PerformanceReview[] = [];
            for (const review of reviews) {
                const userSnap = await db.collection('users').doc(review.subjectUid).get();
                const chapterId = userSnap.exists ? (userSnap.data() || {}).chapterId || null : null;
                if (chapterId === ownChapterOnly) filtered.push(review);
            }
            reviews = filtered;
        }
        return NextResponse.json({ success: true, term, terms: recentQuarterKeys(4), reviews });
    } catch (err: any) {
        console.error('[api/admin/performance-reviews GET]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const access = await requireWriteAccess(req);
        if (!access.ok) return access.res;
        const { db, actorUid } = access;

        const body = await req.json().catch(() => null);
        const params = req.nextUrl.searchParams;
        const subjectUid = subjectFrom(params, body);
        if (!subjectUid) {
            return NextResponse.json({ error: 'Bad request', message: 'subjectUid is required' }, { status: 400 });
        }
        const term = termFrom(params, body) || quarterKeyOf(new Date());
        if (!isValidReviewTermKey(term)) {
            return NextResponse.json(
                { error: 'Bad request', message: 'term must be a fiscal quarter key like FY27-Q1' },
                { status: 400 },
            );
        }
        const userSnap = await db.collection('users').doc(subjectUid).get();
        if (!userSnap.exists) {
            return NextResponse.json({ error: 'Not found', message: 'No member with that uid' }, { status: 404 });
        }

        const review = await generatePerformanceReview(db, { subjectUid, termKey: term, actorUid });
        return NextResponse.json({ success: true, review });
    } catch (err: any) {
        console.error('[api/admin/performance-reviews POST]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        const access = await requireWriteAccess(req);
        if (!access.ok) return access.res;
        const { db, actorUid } = access;

        const body = await req.json().catch(() => null);
        const params = req.nextUrl.searchParams;
        let subjectUid = subjectFrom(params, body);
        let term = termFrom(params, body);
        if (!subjectUid || !term) {
            const fromPath = identityFromPath(req);
            subjectUid = subjectUid || fromPath.subjectUid;
            term = term || fromPath.term;
        }
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
            actorUid,
        });
        if (!result.ok) {
            return NextResponse.json({ error: 'Bad request', message: result.message }, { status: result.status });
        }
        return NextResponse.json({ success: true, review: result.review });
    } catch (err: any) {
        console.error('[api/admin/performance-reviews PUT]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
