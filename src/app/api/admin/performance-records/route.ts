/**
 * GET /api/admin/performance-records - Variant I (internalise) surface
 * (spec E.7).
 *
 * Exists ONLY when settings/discipline.warningRegistryVariant is
 * 'internal'; under the default Variant R it answers 404. This is the
 * non-shaming internal replacement for the retired public registry:
 * decided disciplinary cases (case number, strike tier, date) and
 * deadline miss counts, visible to entitled offices only. Content
 * rules: NO constitutional grounds, NO narratives, NO evidence - the
 * word "warning" appears only inside "formal warning (Strike 1)".
 * Chapter Presidents see only their own chapter (server-side filter).
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { isFounderUid, resolveActorOffices } from '@/lib/server/discipline/adapters';
import { getDisciplineSettings } from '@/lib/server/discipline/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VIEWER_OFFICES = ['ngs', 'audit_chair', 'membership_director', 'chapter_president'];

export async function GET(req: NextRequest) {
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
        const ownChapterOnly = !isFounderUid(actor.uid) && actor.offices.length === 1 && actor.offices[0] === 'chapter_president'
            ? actor.chapterId
            : null;

        const snap = await db
            .collection('disciplinary_cases')
            .where('status', 'in', ['sanction_applied', 'closed'])
            .get();

        const records: Array<{
            caseNumber: string;
            subjectUid: string;
            tier: string;
            decidedAt: string | null;
        }> = [];
        const subjectUids = new Set<string>();
        snap.forEach((d: any) => {
            const c = d.data() || {};
            if (c.strikeNumber === null || c.strikeNumber === undefined) return;
            if (c.decision === 'dismissed' || !c.decision) return;
            subjectUids.add(c.subjectUid);
            records.push({
                caseNumber: c.caseNumber,
                subjectUid: c.subjectUid,
                tier:
                    c.strikeNumber === 1
                        ? 'formal warning (Strike 1)'
                        : c.strikeNumber === 2
                          ? 'Strike 2 (suspension)'
                          : 'Strike 3 (expulsion recommendation)',
                decidedAt: c.decidedAt || c.closedAt || null,
            });
        });

        if (ownChapterOnly) {
            const chapterByUid = new Map<string, string | null>();
            for (const uid of subjectUids) {
                const userSnap = await db.collection('users').doc(uid).get();
                chapterByUid.set(uid, userSnap.exists ? (userSnap.data() || {}).chapterId || null : null);
            }
            for (let i = records.length - 1; i >= 0; i--) {
                if (chapterByUid.get(records[i].subjectUid) !== ownChapterOnly) records.splice(i, 1);
            }
        }

        const missSnap = await db.collection('deadline_miss_records').get();
        const missCounts: Record<string, number> = {};
        missSnap.forEach((d: any) => {
            const m = d.data() || {};
            if (m.subjectUid) missCounts[m.subjectUid] = (missCounts[m.subjectUid] || 0) + 1;
        });

        records.sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')));
        return NextResponse.json({ success: true, records, missCounts });
    } catch (err: any) {
        console.error('[api/admin/performance-records]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
