import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
    resolveAdminTasksSupaAdapter,
    listTasksByWorkflowDocs,
} from "@/lib/supa/seam-admin-tasks";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/by-workflow?workflowId=<id>
 *
 * NEW surface (supa migration, tasks cluster group 3). Server counterpart
 * for the admin tasks page's direct Firestore workflow-steps query
 * (tasks where workflowId ==, orderBy sequenceIndex asc) used by the
 * edit dialog deep-fetch. This is NOT the workflows route
 * (src/app/api/workflows/route.ts is pinned and untouched).
 *
 * Flag OFF / adapter absent: 404 — the page keeps its exact Firestore
 * query. Flag ON: seam read; any seam error falls back to the same
 * Firestore query so the response contract never changes.
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
        const workflowId = searchParams.get('workflowId') || '';
        if (!workflowId) {
            return NextResponse.json({ error: 'Invalid request: workflowId is required' }, { status: 400 });
        }

        try {
            const tasks = await listTasksByWorkflowDocs(adapter, workflowId);
            return NextResponse.json({ tasks });
        } catch (seamError) {
            console.warn('[api/tasks/by-workflow] seam read failed; falling back to Firestore', seamError);
            const snap = await db.collection('tasks')
                .where('workflowId', '==', workflowId)
                .orderBy('sequenceIndex', 'asc')
                .get();
            return NextResponse.json({ tasks: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) });
        }
    } catch (error: any) {
        console.error('Tasks by-workflow Error:', error);
        return NextResponse.json({ error: error.message || 'Failed to fetch workflow steps' }, { status: 500 });
    }
}
