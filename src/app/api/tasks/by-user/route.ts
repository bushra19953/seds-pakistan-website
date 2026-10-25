import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
    resolveAdminTasksSupaAdapter,
    listTasksByAssigneeDocs,
    listTasksCreatedByDocs,
} from "@/lib/supa/seam-admin-tasks";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/by-user?userId=<uid>&mode=assigned|created
 *
 * NEW surface (supa migration, tasks cluster group 3). Server counterpart
 * for the client helpers getUserTasks / getTasksCreatedBy in
 * src/lib/task-management.ts, whose query shapes (assigneeId ==,
 * assigneeIds array-contains, assignerId ==) have no existing server
 * route. The main task list stays on GET /api/tasks (group 1).
 *
 * Flag OFF / adapter absent: 404 — the endpoint is inert and the client
 * helpers keep their exact Firestore behavior. Flag ON: reads are
 * served by the seam adapter; any seam error falls back to the same
 * query shapes on Firestore so the response contract never changes.
 */
export async function GET(request: NextRequest) {
    try {
        const adapter = await resolveAdminTasksSupaAdapter();
        if (!adapter) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }

        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
        }

        const authResult = await verifyAuthentication(request);
        if (!authResult.authenticated || !authResult.user) {
            return NextResponse.json({ error: authResult.error || 'Unauthorized' }, { status: 401 });
        }
        const decoded: any = authResult.user.user || {};
        let canManage = !!(
            (decoded.permissions && decoded.permissions.manageTasks === true) ||
            decoded.manageTasks === true ||
            decoded.canManageTasks === true
        );
        if (!canManage) {
            canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageTasks');
        }
        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('userId') || '';
        const mode = searchParams.get('mode') === 'created' ? 'created' : 'assigned';
        if (!userId) {
            return NextResponse.json({ error: 'Invalid request: userId is required' }, { status: 400 });
        }

        try {
            const tasks = mode === 'created'
                ? await listTasksCreatedByDocs(adapter, userId)
                : await listTasksByAssigneeDocs(adapter, userId);
            return NextResponse.json({ tasks });
        } catch (seamError) {
            console.warn('[api/tasks/by-user] seam read failed; falling back to Firestore', seamError);
            const tasksRef = db.collection('tasks');
            if (mode === 'created') {
                const snap = await tasksRef.where('assignerId', '==', userId).get();
                return NextResponse.json({ tasks: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) });
            }
            const [s1, s2] = await Promise.all([
                tasksRef.where('assigneeId', '==', userId).get(),
                tasksRef.where('assigneeIds', 'array-contains', userId).get(),
            ]);
            const seen = new Set<string>();
            const tasks = [...s1.docs, ...s2.docs]
                .filter((d: any) => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
                .map((d: any) => ({ id: d.id, ...d.data() }));
            return NextResponse.json({ tasks });
        }
    } catch (error: any) {
        console.error('Tasks by-user Error:', error);
        return NextResponse.json({ error: error.message || 'Failed to fetch tasks' }, { status: 500 });
    }
}
