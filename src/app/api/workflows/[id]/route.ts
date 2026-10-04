export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { deleteWorkflowCascade } from '@/lib/server/workflow-cascade';
import { logWorkflowAudit } from '@/lib/server/workflow-audit';

// Done states that block deletion unless forced. Keep in sync with the
// status strings used in src/app/api/workflows/route.ts ('pending',
// 'completed', 'overdue'); 'approved' is treated as a done state too.
const DONE_STATUSES = new Set(['completed', 'approved']);

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await hasServerPermission(auth.user.role || '', 'canManageTasks'))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    ensureAdminInitialized();
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ ok: false, error: 'Workflow id is required' }, { status: 400 });
    }

    // A workflow is a virtual aggregate: tasks sharing a workflowId string.
    // Existence check: a second DELETE after a successful one lands here
    // and returns 404 instead of failing.
    const existingSnap = await db.collection('tasks').where('workflowId', '==', id).limit(1).get();
    if (existingSnap.empty) {
      return NextResponse.json({ ok: false, error: 'Workflow not found' }, { status: 404 });
    }

    // Confirmation token: the caller must echo the workflow id back.
    const { searchParams } = new URL(req.url);
    const confirm = searchParams.get('confirm');
    if (confirm !== id) {
      return NextResponse.json(
        { error: 'Confirmation required: pass ?confirm=<workflowId>' },
        { status: 400 }
      );
    }

    // Completed-steps guard: count step tasks whose status is a done state.
    const tasksSnap = await db.collection('tasks').where('workflowId', '==', id).get();
    let doneCount = 0;
    tasksSnap.forEach((d) => {
      const status = String((d.data() as any)?.status || '').toLowerCase();
      if (DONE_STATUSES.has(status)) doneCount += 1;
    });
    const force = searchParams.get('force');
    if (doneCount > 0 && force !== 'true') {
      return NextResponse.json(
        { error: 'Workflow has completed steps', completedCount: doneCount },
        { status: 409 }
      );
    }

    // Cascade delete the workflow doc, its step tasks, and related records.
    const { deletedTasks } = await deleteWorkflowCascade(db, id);

    // Audit the deletion.
    await logWorkflowAudit(db, {
      action: 'workflow_deleted',
      workflowId: id,
      actorUid: auth.user.userId,
      details: { deletedTasks, forced: force === 'true' },
    });

    return NextResponse.json({ ok: true, deletedTasks });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
