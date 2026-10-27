export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { deleteWorkflowCascade } from '@/lib/server/workflow-cascade';
import { logWorkflowAudit } from '@/lib/server/workflow-audit';
import { mirrorWorkflowTaskDocById } from '@/lib/server/workflow-write-mirror';

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
    if (!(await hasServerPermissionForUser(getDb() as any, auth.user.userId, 'canManageTasks'))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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

// Serialize a stored deadline value (Firestore Timestamp, Date, or
// { seconds } shape) to an ISO string for responses and audit details.
function deadlineToIso(value: any): string | null {
  if (!value) return null;
  try {
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'object' && typeof value.seconds === 'number') {
      return new Date(value.seconds * 1000).toISOString();
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/**
 * PATCH /api/workflows/[id] — move a workflow's deadline.
 *
 * A workflow has no parent document: POST /api/workflows denormalizes
 * the final deadline onto every step task doc twice (`deadline` = the
 * workflow's final deadline, read by the public mission page header
 * and the PDF; `individualDeadline` = the step's own due date, read
 * by the step lists and overdue logic). Until now neither field could
 * be changed workflow-wide after creation: the Missions UI offered no
 * edit control and PATCH /api/workflows only updates a single step's
 * assignee/status. This handler updates BOTH fields on EVERY step doc
 * to the same new value in one batch, so the workflow can never end
 * up half-moved, then mirrors each doc through the same
 * workflows-surface mirror the create/duplicate writes use.
 *
 * Body: { deadline: string | number, reason?: string }
 * The new deadline must be a real datetime in the future (the same
 * rule POST /api/workflows applies to a new workflow's finalDeadline).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    ensureAdminInitialized();
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });

    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await hasServerPermissionForUser(db, auth.user.userId, 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ ok: false, error: 'Workflow id is required' }, { status: 400 });
    }

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const rawDeadline = body?.deadline;
    const newDeadline =
      typeof rawDeadline === 'string' || typeof rawDeadline === 'number' || rawDeadline instanceof Date
        ? new Date(rawDeadline as any)
        : null;
    if (!newDeadline || isNaN(newDeadline.getTime())) {
      return NextResponse.json({ error: 'Invalid deadline' }, { status: 400 });
    }
    if (newDeadline.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Deadline must be in the future' }, { status: 400 });
    }
    const reason =
      typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : null;

    // A workflow is a virtual aggregate: tasks sharing a workflowId string.
    const snap = await db.collection('tasks').where('workflowId', '==', id).get();
    if (snap.empty) {
      return NextResponse.json({ ok: false, error: 'Workflow not found' }, { status: 404 });
    }
    const docs = snap.docs
      .slice()
      .sort((a: any, b: any) => ((a.data() as any)?.sequenceIndex ?? 0) - ((b.data() as any)?.sequenceIndex ?? 0));

    // The workflow's current deadline, from the first step's parent field
    // (the same value the public mission page header prints).
    const firstData = docs[0].data() as any;
    const previousDeadline = deadlineToIso(firstData?.deadline) || deadlineToIso(firstData?.individualDeadline);

    // One operation: parent deadline + every step deadline move together.
    // Chunked commits stay under Firestore's 500-write batch limit.
    const CHUNK = 400;
    for (let start = 0; start < docs.length; start += CHUNK) {
      const batch = db.batch();
      for (const d of docs.slice(start, start + CHUNK)) {
        batch.update(d.ref, {
          deadline: newDeadline,
          individualDeadline: newDeadline,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }

    // MIRROR (workflows surface): step docs are workflow-owned writes,
    // mirrored exactly like POST /api/workflows and the duplicate route —
    // otherwise the new deadline is invisible on the detail/public/PDF
    // surfaces. Never throws; flag OFF = no-op, no extra reads.
    for (const d of docs) {
      await mirrorWorkflowTaskDocById(d.id, async () => (await d.ref.get()).data());
    }

    await logWorkflowAudit(db, {
      action: 'workflow_deadline_updated',
      workflowId: id,
      actorUid: auth.user.userId,
      details: {
        oldDeadline: previousDeadline,
        newDeadline: newDeadline.toISOString(),
        stepsUpdated: docs.length,
        reason,
      },
    });

    return NextResponse.json({
      ok: true,
      workflowId: id,
      deadline: newDeadline.toISOString(),
      previousDeadline,
      stepsUpdated: docs.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
