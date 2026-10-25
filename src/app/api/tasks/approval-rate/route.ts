import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { getLast10ApprovalRate } from '@/lib/server/task-approval-rate';
import { getApprovalRateViaSeam } from '@/lib/supa/seam-tasks-lists';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/approval-rate?uid=<submitterUid>
 *
 * Grove Item 13: the submitter's last-10 decided-submissions approval
 * rate, computed at read time from the tasks collection (see
 * src/lib/server/task-approval-rate.ts). Read-only: the figure is
 * rendered beside the Approve action on the task-review surfaces so
 * the reviewer sees the performer's record at the inspection point.
 * No stored field, no auto-approval, no rules change.
 *
 * Gated exactly like the universal-review GET: the caller must hold
 * canManageTasks for the tasks collection.
 */
export async function GET(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const uid = searchParams.get('uid');
        if (!uid) {
            return NextResponse.json({ error: 'Missing required query parameter: uid' }, { status: 400 });
        }

        const isAuthorized = await hasServerPermissionForUser(getDb() as any, auth.user.userId, 'canManageTasks');
        if (!isAuthorized) {
            return NextResponse.json({ error: "Forbidden: 'canManageTasks' access required" }, { status: 403 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        // Supa path (flag ON): the seam recomputes the rate from Supa task
        // reads using the same pure helpers and the same decided/approved
        // status vocabularies (completed | approved | rejected |
        // changes-requested; approved = completed | approved). Seam null
        // (flag OFF / adapter absent / adapter error) uses the Firestore
        // computation verbatim. The canManageTasks permission check above
        // stays on Firestore (src/lib/server/permissions.ts) on both paths.
        const seamResult = await getApprovalRateViaSeam(uid);
        const result = seamResult ?? await getLast10ApprovalRate(db, uid);
        return NextResponse.json({ success: true, uid, ...result });
    } catch (error: any) {
        console.error('[approval-rate GET] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
