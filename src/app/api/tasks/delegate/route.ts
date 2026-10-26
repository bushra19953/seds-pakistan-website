import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { calculateWorkflowDeadlines } from '@/lib/workflow-utils';
import { sendEmailNotification } from '@/lib/mailer';
import {
  getTaskDocViaSeam,
  getUserDocViaSeam,
  listUsersByIdsViaSeam,
  updateTaskDocViaSeam,
} from '@/lib/supa/seam-tasks-delegate';
import {
  mirrorNotificationCreate,
  userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';
import { format } from 'date-fns';
import {
  flushPendingUsersPrimaryOps,
  type PendingUsersPrimaryOp,
} from '@/lib/server/supa-identity-primary';


export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST: Mission Command Orchestration
 * Breaks a task into multiple sub-tasks assigned to different people in the sub-hierarchy.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const body = await request.json();
    const { taskId, pointsKept, reason, workflowSteps } = body;

    if (!taskId) return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    if (!Array.isArray(workflowSteps) || workflowSteps.length === 0) {
      return NextResponse.json({ error: 'workflowSteps are required for orchestration' }, { status: 400 });
    }

    // FD-01 (pre-existing defect, owned by the defect-fix program — do
    // NOT fix here): `auth.user` is an AuthContext with no top-level
    // `uid`, so callerUid is always undefined and the assignee check
    // below always 403s. Preserved byte-identically on purpose; see
    // src/lib/supa/seam-tasks-delegate.ts and supa-rebase-notes/tasks-4.md.
    const callerUid = (auth.user as any).uid;

    const taskRef = db.collection('tasks').doc(taskId);
    // Supa seam: identical read via the adapter when the 'tasks' flag
    // is ON; null (flag OFF / adapter absent / error) falls back to the
    // original Firestore read. Ordering is unchanged: auth -> body
    // validation -> callerUid -> task read -> assignee check (403).
    const taskSnap = (await getTaskDocViaSeam(taskId)) ?? (await taskRef.get());
    if (!taskSnap.exists) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const task = taskSnap.data()!;
    const taskAssigneeIds: string[] = Array.isArray(task.assigneeIds) && task.assigneeIds.length
      ? task.assigneeIds.map(String)
      : (task.assigneeId ? [String(task.assigneeId)] : []);
    if (!taskAssigneeIds.includes(callerUid)) {
      return NextResponse.json({ error: 'Only the task assignee can delegate' }, { status: 403 });
    }

    const totalTaskPoints = task.points || 0;
    const stepsPoints = workflowSteps.reduce((sum, s) => sum + (s.points || 0), 0);
    
    if (stepsPoints + (pointsKept || 0) !== totalTaskPoints) {
      return NextResponse.json({ 
        error: `Point mismatch. Total: ${totalTaskPoints}, Sum of steps: ${stepsPoints}, Kept: ${pointsKept || 0}` 
      }, { status: 400 });
    }

    // Unreachable past the FD-01 403 above; read routed through the
    // seam structurally, reachability unchanged.
    const callerDoc = (await getUserDocViaSeam(callerUid)) ?? (await db.collection('users').doc(callerUid).get());
    const callerName = callerDoc.data()?.displayName || callerDoc.data()?.email || 'Unknown';

    const workflowId = `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workflowTitle = `[Orchestrated] ${task.title}`;

    const parentDeadline = task.deadline?.toDate?.() || task.deadline;
    const finalDeadline = parentDeadline && new Date(parentDeadline).getTime() > Date.now()
      ? new Date(parentDeadline)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const stepDeadlines = calculateWorkflowDeadlines(finalDeadline, workflowSteps);

    // Resolve each step's assignees as an array (primary first, for compat with
    // the singular assigneeId readers). A step with no assignee can never launch.
    const stepAssigneeIds = (s: any): string[] =>
      Array.isArray(s.assigneeIds) && s.assigneeIds.length
        ? Array.from(new Set(s.assigneeIds.map(String).filter(Boolean)))
        : (s.assigneeId ? [String(s.assigneeId)] : []);
    for (const s of workflowSteps) {
      if (stepAssigneeIds(s).length === 0) {
        return NextResponse.json({ error: 'Every workflow step needs at least one assignee' }, { status: 400 });
      }
    }

    // Discipline (spec E.4.8): delegation is a privilege - a member under
    // a Strike 2 suspension may not delegate; and a BANNED member may not
    // be made a delegate target (this check was missing entirely).
    {
      const { suspensionBlock, findBannedDelegateTarget } = await import('@/lib/server/discipline/suspension');
      const block = await suspensionBlock(db, callerUid, new Date());
      if (block) {
        return NextResponse.json(block, { status: 403 });
      }
      const targetUids = Array.from(new Set(workflowSteps.flatMap((s: any) => stepAssigneeIds(s))));
      const bannedTarget = await findBannedDelegateTarget(db, targetUids);
      if (bannedTarget) {
        return NextResponse.json(
          { error: 'DELEGATE_TARGET_BANNED', message: `Delegate target ${bannedTarget} is banned and cannot receive delegated work.` },
          { status: 403 },
        );
      }
    }

    const participantIds = new Set<string>([callerUid]);
    const createdTaskIds: string[] = [];
    // GAP-N1: notification writes queued in the batch below; mirrored to
    // Supabase only after the batch commit succeeds (flag-gated,
    // non-throwing; Firestore stays primary).
    const notifMirrors: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];

    const batch = db.batch();
    const pendingUsersPrimary: PendingUsersPrimaryOp[] = [];

    // Fetch subordinate details for email notifications (chunked: 'in' caps at 10)
    const subIds = Array.from(new Set(workflowSteps.flatMap(stepAssigneeIds)));
    const userDetailsMap = new Map();
    for (let c = 0; c < subIds.length; c += 10) {
      const chunk = subIds.slice(c, c + 10);
      // Unreachable past the FD-01 403 above; read routed through the
      // seam structurally, reachability unchanged.
      const seamUsers = await listUsersByIdsViaSeam(chunk);
      if (seamUsers) {
        seamUsers.forEach(d => userDetailsMap.set(d.id, d.data));
      } else {
        const usersSnap = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get();
        usersSnap.docs.forEach(d => userDetailsMap.set(d.id, d.data()));
      }
    }

    for (let i = 0; i < workflowSteps.length; i++) {
      const step = workflowSteps[i];
      const stepIds = stepAssigneeIds(step);
      stepIds.forEach(id => participantIds.add(id));
      const subTaskRef = db.collection('tasks').doc();

      batch.set(subTaskRef, {
        title: step.title,
        description: step.description,
        assignerId: callerUid,
        assigneeId: stepIds[0],
        assigneeIds: stepIds,
        workflowId,
        workflowTitle,
        sequenceIndex: i,
        isCurrentStep: i === 0,
        deadline: finalDeadline,
        individualDeadline: stepDeadlines[i] || finalDeadline,
        status: 'pending',
        points: step.points,
        isSubTask: true,
        parentTaskId: taskId,
        delegatedBy: callerUid,
        delegatedByName: callerName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      createdTaskIds.push(subTaskRef.id);

      // Fan out per assignee: counters, in-app notifications, and emails go to
      // every assignee on the step, not just the primary. pointsKept stays a
      // single per-delegator value on the parent task; it is never multiplied.
      for (const uid of stepIds) {
        const subTaskLink = `/profile/unified?uid=${uid}&task=${subTaskRef.id}`;

        const delegateCounterPayload = {
          tasksAssignedCount: admin.firestore.FieldValue.increment(1),
          lastTaskAssignedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        batch.set(db.collection('users').doc(uid), delegateCounterPayload, { merge: true });
        // WRITE PRIMACY (G-USER-5, U-42): queued primary RMW op.
        pendingUsersPrimary.push({ uid, payload: delegateCounterPayload });

        const notifRef = db.collection('users').doc(uid).collection('notifications').doc();
        const notifData = {
          type: 'task_delegation',
          title: 'New Mission Assignment',
          body: `${callerName} assigned you a mission step in "${task.title}".`,
          link: subTaskLink,
          taskId: subTaskRef.id,
          isRead: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };
        batch.set(notifRef, notifData);
        notifMirrors.push({ uid, id: notifRef.id, data: notifData });

        // TRIGGER EMAIL
        const subUser = userDetailsMap.get(uid);
        if (subUser?.email) {
          sendEmailNotification(subUser.email, 'task_assigned', {
            recipientName: subUser.displayName || subUser.email,
            taskTitle: step.title,
            taskLink: subTaskLink,
            actorName: callerName,
            dueDate: stepDeadlines[i] ? format(stepDeadlines[i], 'MMM dd, yyyy') : undefined
          }).catch(e => console.warn(`[orchestrate] Email failed for ${subUser.email}:`, e));
        }
      }
    }

    for (const uid of Array.from(participantIds)) {
      batch.set(db.collection('workflow_members').doc(`${workflowId}_${uid}`), {
        workflowId,
        userId: uid,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        role: uid === callerUid ? 'owner' : 'member',
      }, { merge: true });
    }

    batch.update(taskRef, {
      status: 'in-progress',
      orchestration: {
        workflowId,
        stepsCount: workflowSteps.length,
        pointsKept,
        pointsDelegated: stepsPoints,
        subTaskIds: createdTaskIds,
        orchestratedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    });

    batch.set(taskRef.collection('activity').doc(), {
      type: 'mission_orchestration',
      userId: callerUid,
      userName: callerName,
      data: { workflowId, stepCount: workflowSteps.length, totalDelegated: stepsPoints, pointsKept },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // WRITE PRIMACY flush (U-42): primary RMW ops before commit.
    await flushPendingUsersPrimaryOps(pendingUsersPrimary);
    await batch.commit();
    // GAP-N1: mirror the committed notification writes (best-effort).
    for (const m of notifMirrors) {
      await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
    }
    return NextResponse.json({ success: true, workflowId });

  } catch (error: any) {
    console.error('[orchestrate] POST error:', error);
    return NextResponse.json({ error: error.message || 'Failed to orchestrate mission' }, { status: 500 });
  }
}

/**
 * PATCH: Respond to a delegation request (accept or reject).
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const { taskId, action } = await request.json();
    if (!taskId || !['accept', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'taskId and action (accept/reject) required' }, { status: 400 });
    }

    // FD-01 (pre-existing defect — do NOT fix here): same non-existent
    // `auth.user.uid` read as in POST; callerUid is always undefined.
    // TS-P01: nothing writes task.delegation, so the 'No pending
    // delegation' 400 below always fires first anyway. See the seam
    // module header and supa-rebase-notes/tasks-4.md.
    const callerUid = (auth.user as any).uid;
    const taskRef = db.collection('tasks').doc(taskId);
    // Supa seam: identical read via the adapter when the 'tasks' flag
    // is ON; null falls back to the original Firestore read.
    const taskSnap = (await getTaskDocViaSeam(taskId)) ?? (await taskRef.get());
    if (!taskSnap.exists) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const task = taskSnap.data()!;
    const delegation = task.delegation;

    if (!delegation || delegation.status !== 'pending') {
      return NextResponse.json({ error: 'No pending delegation' }, { status: 400 });
    }

    if (delegation.delegatedTo !== callerUid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Unreachable (TS-P01 + FD-01 above); writes routed through the
    // seam structurally, reachability unchanged.
    if (action === 'accept') {
      const fields = { 'delegation.status': 'accepted', 'delegation.respondedAt': new Date() };
      if (!(await updateTaskDocViaSeam(taskId, fields))) {
        await taskRef.update(fields);
      }
      return NextResponse.json({ success: true, status: 'accepted' });
    } else {
      const fields = { 'delegation.status': 'rejected', 'delegation.respondedAt': new Date() };
      if (!(await updateTaskDocViaSeam(taskId, fields))) {
        await taskRef.update(fields);
      }
      return NextResponse.json({ success: true, status: 'rejected' });
    }
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to respond to delegation' }, { status: 500 });
  }
}
