/**
 * /api/discipline/cases/[caseId]/referral - confirm or dismiss a cron
 * referral draft (spec E.6.4). Confirm sets the constitutional ground;
 * dismiss records a reason and marks the linked misses
 * dismissed_pattern. The subject is never notified of either.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { DisciplineError } from '@/lib/server/discipline/case-service';
import { resolveActorOffices } from '@/lib/server/discipline/adapters';
import { confirmDraft, dismissDraft } from '@/lib/server/discipline/referral';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
        const now = new Date();
        if (body?.action === 'confirm') {
            const updated = await confirmDraft(db, params.caseId, actor, body.payload || {}, now);
            return NextResponse.json({ success: true, case: updated });
        }
        if (body?.action === 'dismiss') {
            const updated = await dismissDraft(db, params.caseId, actor, body.decisionReason || '', now);
            return NextResponse.json({ success: true, case: updated });
        }
        return NextResponse.json({ error: 'UNKNOWN_ACTION', message: 'action must be confirm or dismiss' }, { status: 400 });
    } catch (err: any) {
        if (err instanceof DisciplineError) {
            return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
        }
        console.error('[api/discipline/referral]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
