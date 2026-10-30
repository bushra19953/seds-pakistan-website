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
 *
 * READ-BLEED TRAIN 2 (census 04 T13): the Firestore fallback now
 * carries .limit(100) (steps per workflow; the largest known workflow
 * has ~23) and its failure is CAUGHT — the route serves a degraded
 * { tasks: [], degraded: true } instead of an uncaught 500. The
 * permission check fails CLOSED (403, census 04 T4) when the
 * permission bundle loader throws.
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
                console.error('[api/tasks/by-workflow] permission check failed; denying (fail-closed)', permErr);
                canManage = false;
            }
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
            try {
                const snap = await db.collection('tasks')
                    .where('workflowId', '==', workflowId)
                    .orderBy('sequenceIndex', 'asc')
                    .limit(100)
                    .get();
                return NextResponse.json({ tasks: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) });
            } catch (fallbackError) {
                console.error('[api/tasks/by-workflow] seam AND Firestore fallback both failed; serving a degraded empty list', fallbackError);
                return NextResponse.json({ tasks: [], degraded: true });
            }
        }
    } catch (error: any) {
        console.error('Tasks by-workflow Error:', error);
        return NextResponse.json({ error: error.message || 'Failed to fetch workflow steps' }, { status: 500 });
    }
}
