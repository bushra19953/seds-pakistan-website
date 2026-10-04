import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { deleteWorkflowCascade } from '@/lib/server/workflow-cascade';
import { logWorkflowAudit } from '@/lib/server/workflow-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(20),
  confirm: z.literal(true, { errorMap: () => ({ message: 'confirm must be exactly true' }) }),
  force: z.boolean().optional(),
});

// A workflow step counts as done when a task reached 'completed' or
// 'approved'. These are the two terminal success states used by the
// gamification transaction layer and the tasks API.
function isDoneStatus(status: unknown): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'completed' || s === 'approved';
}

export async function POST(request: NextRequest) {
  try {
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }

    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }
    if (!(await hasServerPermission(auth.user.role || '', 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = BulkDeleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', issues: parsed.error.flatten() }, { status: 400 });
    }
    const force = parsed.data.force === true;

    // Dedupe ids so each workflow is processed exactly once.
    const ids = Array.from(new Set(parsed.data.ids));

    const deleted: string[] = [];
    const skipped: string[] = [];
    const blocked: Array<{ id: string; completedCount: number }> = [];

    for (const id of ids) {
      const tasksSnap = await db.collection('tasks').where('workflowId', '==', id).get();

      // Unknown workflow: record as skipped, not an error.
      if (tasksSnap.empty) {
        skipped.push(id);
        continue;
      }

      // Same completed-steps guard as single delete: a workflow with done
      // steps is blocked unless the caller explicitly forces the delete.
      let completedCount = 0;
      for (const doc of tasksSnap.docs) {
        if (isDoneStatus((doc.data() as any)?.status)) completedCount += 1;
      }
      if (completedCount > 0 && !force) {
        blocked.push({ id, completedCount });
        continue;
      }

      const result = await deleteWorkflowCascade(db, id);
      void result;
      deleted.push(id);
    }

    // One audit entry for the whole bulk operation.
    await logWorkflowAudit(db, {
      action: 'workflows_bulk_deleted',
      workflowId: 'bulk',
      actorUid: auth.user.userId,
      details: { deleted, skipped, blocked },
    });

    return NextResponse.json({ ok: true, deleted, skipped, blocked });
  } catch (e: any) {
    return NextResponse.json({ error: 'Internal Server Error', details: e?.message ?? String(e) }, { status: 500 });
  }
}
