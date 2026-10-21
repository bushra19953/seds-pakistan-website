/**
 * GET /api/discipline/miss-records - deadline miss record counts for
 * admin surfaces (spec E.8: the defaulters page "Miss records (28d)"
 * column).
 *
 * Query: ?days=28 (default 28), optional ?subjectUid=<uid> to return
 * the records themselves for one member.
 * Gate: an entitled office (or the Founder). Miss records are internal
 * facts; they are never exposed to the subject or the public.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isFounderUid, resolveActorOffices } from '@/lib/server/discipline/adapters';

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
        const actor = await resolveActorOffices(db, auth.user.userId);
        if (actor.offices.length === 0 && !isFounderUid(actor.uid)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const url = new URL(req.url);
        const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') || 28)));
        const subjectUid = url.searchParams.get('subjectUid');
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        let q = db.collection('deadline_miss_records').where('detectedAt', '>=', since);
        if (subjectUid) q = q.where('subjectUid', '==', subjectUid);
        const snap = await q.get();
        const counts: Record<string, number> = {};
        const records: any[] = [];
        snap.forEach((d: any) => {
            const data = d.data() || {};
            counts[data.subjectUid] = (counts[data.subjectUid] || 0) + 1;
            if (subjectUid) records.push({ missId: d.id, ...data });
        });
        return NextResponse.json({ success: true, days, counts, ...(subjectUid ? { records } : {}) });
    } catch (err: any) {
        console.error('[api/discipline/miss-records]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
