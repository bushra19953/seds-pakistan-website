import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
    resolveAdminTasksSupaAdapter,
    listAllTaskDocs,
} from "@/lib/supa/seam-admin-tasks";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * GET /api/tasks/all?limit=<n>
 *
 * NEW surface (supa migration, tasks cluster group 3). Server counterpart
 * for the client helper getAllTasks in src/lib/task-management.ts.
 *
 * BOUNDEDNESS: getAllTasks on the client is an UNBOUNDED full tasks
 * getDocs today. This endpoint is deliberately bounded server-side:
 * limit defaults to 500 and is capped at 2000. The seam forwards the
 * limit to the adapter. See the boundedness risk flag in
 * supa-rebase-notes/tasks-3.md — faithful client call semantics are
 * preserved in this wave; bounding/retiring the helper is a planner
 * follow-up.
 *
 * Flag OFF / adapter absent: 404 — the endpoint is inert and the client
 * helper keeps its exact Firestore behavior. Flag ON: reads are served
 * by the seam adapter; any seam error falls back to a bounded Firestore
 * read of the same shape.
 *
 * GAP-T3-01 — CLOSED (cutover program, feat/supa-cut-tasks; ratified by
 * Zubair's Option A order). The ON-path error/bound semantics are now
 * pinned (suite: supa-tasks-all-gap-t3.test.ts):
 *   - flag OFF / adapter absent -> 404 { error: 'Not found' } (the OFF
 *     path's observable contract; unchanged).
 *   - unauthenticated -> 401; lacking canManageTasks -> 403 (both
 *     before any data read).
 *   - limit: default 500, explicit values floored and capped at 2000;
 *     the seam REQUIRES an explicit limit — listAllTaskDocs throws
 *     TASKS_ALL_LIMIT_REQUIRED on a no-limit call, so truncation at the
 *     stated bound is a documented contract, never a silent default.
 *   - seam read failure -> bounded Firestore fallback with the SAME
 *     limit, same response shape { tasks, limit }.
 *   - seam AND fallback both fail -> 500 { error: <message> } from the
 *     outer catch. There is no path from a failed read to an unbounded
 *     collection read.
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
        const rawLimit = Number(searchParams.get('limit'));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
            : DEFAULT_LIMIT;

        try {
            const tasks = await listAllTaskDocs(adapter, limit);
            return NextResponse.json({ tasks, limit });
        } catch (seamError) {
            console.warn('[api/tasks/all] seam read failed; falling back to Firestore', seamError);
            const snap = await db.collection('tasks').limit(limit).get();
            return NextResponse.json({ tasks: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })), limit });
        }
    } catch (error: any) {
        console.error('Tasks all Error:', error);
        return NextResponse.json({ error: error.message || 'Failed to fetch tasks' }, { status: 500 });
    }
}
