export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { deleteWorkflowCascade } from '@/lib/server/workflow-cascade';
import { logWorkflowAudit } from '@/lib/server/workflow-audit';
import { mirrorWorkflowTaskDocFromData } from '@/lib/server/workflow-write-mirror';
import { listMissionStepsViaSupa, getMissionReadsSupaAdapter, TASKS_COLLECTION } from '@/lib/server/mission-reads-supa';

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
    // Bounded (census 05, unbounded list #5): one workflow's steps —
    // the largest known workflow has ~23; 500 is a hard ceiling.
    const tasksSnap = await db.collection('tasks').where('workflowId', '==', id).limit(500).get();
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

    // Cascade delete the workflow doc, its step tasks, and related
    // records. The step refs just read for the guard are passed
    // through so the cascade does not re-read the same steps
    // (census 05: route + cascade double read).
    const stepRefs: any[] = [];
    tasksSnap.forEach((d) => stepRefs.push(d.ref));
    const { deletedTasks } = await deleteWorkflowCascade(db, id, stepRefs);

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

    // Seam-first resolve (MSG26 Job 1, same ladder as MSG22 fix #2's
    // getTask and the missions detail route): the mission detail
    // route serves steps through listMissionStepsViaSupa, but this
    // handler resolved only through Firestore, so a workflow whose
    // steps live only in the Supabase mirror 404'd here while
    // reading fine. A non-null, non-empty seam result is served
    // from the seam through the adapter as the primary write; null
    // (flag OFF / unconfigured / adapter error) or empty falls
    // back to exactly today's Firestore path below, so every
    // workflow that edits fine today keeps editing fine.
    // Deliberate deviation from getTask's authoritative miss: the
    // workflows surface is not declared Supabase-primary and the
    // Missions tab list is Firestore-served (/api/workflows), so a
    // seam-empty fallback preserves Firestore-only workflows
    // instead of newly 404ing them. Mirror-only workflows always
    // have non-empty seam steps, so the reported bug is fixed in
    // all cases. If the lead wants strict authoritative-miss, the
    // fallback is the single `else` branch below.
    const supaSteps = await listMissionStepsViaSupa(id);
    const seamAdapter =
      supaSteps !== null && supaSteps.length > 0
        ? await getMissionReadsSupaAdapter()
        : null;
    if (seamAdapter && supaSteps !== null && supaSteps.length > 0) {
      // Bounded like the Firestore path (limit 500): one workflow's
      // steps, sorted so the first step carries the header deadline.
      const seamSteps = supaSteps
        .slice(0, 500)
        .sort((a: any, b: any) => (((a.data as any)?.sequenceIndex ?? 0) - ((b.data as any)?.sequenceIndex ?? 0)));
      const firstSeamData = seamSteps[0].data as any;
      const seamPreviousDeadline = deadlineToIso(firstSeamData?.deadline) || deadlineToIso(firstSeamData?.individualDeadline);

      // Primary write: one adapter updateDoc per step. The mirror
      // stores ISO strings, and a primary write cannot defer
      // updatedAt to a Firestore serverTimestamp, so it resolves
      // to the current instant (same rule as resolveForPrimaryWrite
      // in seam-tasks-route).
      const newDeadlineIso = newDeadline.toISOString();
      const updatedAtIso = new Date().toISOString();
      for (const step of seamSteps) {
        await seamAdapter.updateDoc(TASKS_COLLECTION, step.id, {
          deadline: newDeadlineIso,
          individualDeadline: newDeadlineIso,
          updatedAt: updatedAtIso,
        });
      }

      // Best-effort Firestore mirror (MSG22 fix #2's seam-only save
      // direction): a full-image merge-set materializes the mirror
      // copy with real Timestamps. A mirror failure never fails
      // the committed primary write.
      for (const step of seamSteps) {
        try {
          const fsImage: Record<string, any> = {
            ...((step.data as any) || {}),
            deadline: newDeadline,
            individualDeadline: newDeadline,
            updatedAt: new Date(),
          };
          for (const field of ['createdAt', 'updatedAt', 'deadline', 'individualDeadline', 'completedAt', 'submittedAt', 'approvedAt', 'rejectedAt', 'acceptedAt', 'startedAt', 'availabilityConfirmedAt']) {
            const v = fsImage[field];
            if (typeof v === 'string') {
              const d = new Date(v);
              if (!Number.isNaN(d.getTime())) fsImage[field] = admin.firestore.Timestamp.fromDate(d);
            } else if (v instanceof Date && !Number.isNaN(v.getTime())) {
              fsImage[field] = admin.firestore.Timestamp.fromDate(v);
            }
          }
          await db.collection('tasks').doc(step.id).set(fsImage, { merge: true });
        } catch (mirrorErr) {
          console.warn('[workflows:route] Seam deadline move: Firestore mirror set failed (primary write already committed):', mirrorErr);
        }
      }

      await logWorkflowAudit(db, {
        action: 'workflow_deadline_updated',
        workflowId: id,
        actorUid: auth.user.userId,
        details: {
          oldDeadline: seamPreviousDeadline,
          newDeadline: newDeadlineIso,
          stepsUpdated: seamSteps.length,
          reason,
        },
      });

      return NextResponse.json({
        ok: true,
        workflowId: id,
        deadline: newDeadlineIso,
        previousDeadline: seamPreviousDeadline,
        stepsUpdated: seamSteps.length,
      });
    }

    // A workflow is a virtual aggregate: tasks sharing a workflowId string.
    // Bounded (census 05, unbounded list #5): one workflow's steps.
    const snap = await db.collection('tasks').where('workflowId', '==', id).limit(500).get();
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
    // surfaces. Never throws; flag OFF = no-op. Payload form (census
    // 23 A5): each step's pre-image was already read by the query
    // above and the update is known exactly, so the mirror payload is
    // composed in memory — zero re-reads (this loop used to pay one
    // get per step, doubling the route's read cost).
    for (const d of docs) {
      await mirrorWorkflowTaskDocFromData(d.id, {
        ...((d.data() as any) || {}),
        deadline: newDeadline,
        individualDeadline: newDeadline,
        updatedAt: new Date(),
      });
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
