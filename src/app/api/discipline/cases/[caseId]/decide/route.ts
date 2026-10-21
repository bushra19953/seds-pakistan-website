/**
 * /api/discipline/cases/[caseId]/decide - the decision endpoint.
 * Delegates to applyCaseDecision, the ONE sanction writer (spec E.4.5).
 * Office validation happens server-side in the service; this route only
 * authenticates and resolves the actor.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { applyCaseDecision } from '@/lib/server/discipline/apply-decision';
import { DisciplineError } from '@/lib/server/discipline/case-service';
import { resolveActorOffices } from '@/lib/server/discipline/adapters';

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
        const updated = await applyCaseDecision(db, params.caseId, body, actor, new Date());
        return NextResponse.json({ success: true, case: updated });
    } catch (err: any) {
        if (err instanceof DisciplineError) {
            return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
        }
        console.error('[api/discipline/decide]', err);
        return NextResponse.json({ error: 'INTERNAL', message: err?.message || 'Internal error' }, { status: 500 });
    }
}
