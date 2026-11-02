import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
    resolveAdminTasksSupaAdapter,
    getTaskDoc,
} from "@/lib/supa/seam-admin-tasks";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/by-id?taskId=<id>
 *
 * NEW surface (MSG22 fix #2). Server counterpart for the client helper
 * getTask in src/lib/task-management.ts, whose single-doc read was the
 * one tasks read that never got a seam path: the admin task LIST is
 * seam-served, but Edit fetched the doc from Firestore directly, so a
 * doc held only in the Supabase mirror (the store of record while
 * tasks is SUPA_PRIMARY) listed fine yet read back as missing in Edit.
 * This endpoint serves exactly one doc through seam-admin-tasks
 * (getTaskDoc), following the by-user / by-workflow pattern.
 *
 * Flag OFF / adapter absent: 404, the endpoint is inert and getTask
 * keeps its exact Firestore behavior. Flag ON: the seam answer is
 * authoritative, including a genuine miss, answered as
 * 200 { task: null } so the client never falls back to a store the
 * seam has already superseded. A seam ERROR falls back to the same
 * single-doc Firestore read; if that fails too, the route answers
 * 503 LOUD instead of an uncaught 500. The permission check fails
 * CLOSED (403) when the permission bundle loader throws, matching
 * the sibling endpoints.
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
            try {
                canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageTasks');
            } catch (permErr) {
                console.error('[api/tasks/by-id] permission check failed; denying (fail-closed)', permErr);
                canManage = false;
            }
        }
        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const taskId = searchParams.get('taskId') || '';
        if (!taskId) {
            return NextResponse.json({ error: 'Invalid request: taskId is required' }, { status: 400 });
        }

        try {
            const task = await getTaskDoc(adapter, taskId);
            return NextResponse.json({ task });
        } catch (seamError) {
            console.warn('[api/tasks/by-id] seam read failed; falling back to Firestore', seamError);
            try {
                const snap = await db.collection('tasks').doc(taskId).get();
                return NextResponse.json({
                    task: snap.exists ? { id: snap.id, ...snap.data() } : null,
                });
            } catch (fallbackError) {
                console.error('[api/tasks/by-id] seam AND Firestore fallback both failed; failing loud (503)', fallbackError);
                return NextResponse.json(
                    { error: 'Task is temporarily unavailable. Please retry shortly.', error_code: 'task_by_id_unavailable' },
                    { status: 503 }
                );
            }
        }
    } catch (error: any) {
        console.error('Tasks by-id Error:', error);
        return NextResponse.json({ error: error.message || 'Failed to fetch task' }, { status: 500 });
    }
}
