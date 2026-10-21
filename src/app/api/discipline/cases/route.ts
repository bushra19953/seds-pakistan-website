/**
 * /api/discipline/cases - create + queue list (spec E.8).
 * All writes go through the case service (Admin SDK); firestore rules
 * deny all client writes to disciplinary_cases.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { createCase, DisciplineError } from '@/lib/server/discipline/case-service';
import { resolveActorOffices } from '@/lib/server/discipline/adapters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function errorResponse(err: any) {
    if (err instanceof DisciplineError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[api/discipline/cases]', err);
    return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
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
        const created = await createCase(
            db,
            {
                subjectUid: body.subjectUid,
                constitutionalGround: body.constitutionalGround ?? null,
                groundCSubtype: body.groundCSubtype ?? null,
                groundEDirection: body.groundEDirection ?? null,
                groundNarrative: body.groundNarrative ?? null,
                proposedStrike: body.proposedStrike ?? null,
                evidenceRefs: body.evidenceRefs ?? [],
                linkedTaskIds: body.linkedTaskIds ?? [],
                initiationSource: 'manual',
            },
            actor,
            new Date(),
        );
        return NextResponse.json({ success: true, case: created }, { status: 201 });
    } catch (err: any) {
        return errorResponse(err);
    }
}

export async function GET(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        const actor = await resolveActorOffices(db, auth.user.userId);
        const canViewQueue =
            actor.offices.includes('ngs') ||
            actor.offices.includes('audit_chair') ||
            actor.offices.includes('membership_director') ||
            actor.offices.includes('chapter_president') ||
            actor.offices.includes('founder');
        if (!canViewQueue) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status');
        const view = searchParams.get('view');
        let query: any = db.collection('disciplinary_cases');
        if (status) query = query.where('status', '==', status);
        if (view === 'drafts') {
            query = query.where('initiationSource', '==', 'cron_referral').where('status', '==', 'notice_draft');
        }
        const snap = await query.orderBy('initiatedAt', 'desc').limit(200).get();
        const cases = snap.docs.map((d: any) => ({ caseId: d.id, ...d.data() }));
        return NextResponse.json({ success: true, cases });
    } catch (err: any) {
        return errorResponse(err);
    }
}
