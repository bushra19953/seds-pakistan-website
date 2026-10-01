import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { calculateWorkflowDeadlines } from '@/lib/workflow-utils';
import { sendEmailNotification } from '@/lib/mailer';
import { format } from 'date-fns';

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

    const callerUid = (auth.user as any).uid;

    const taskRef = db.collection('tasks').doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const task = taskSnap.data()!;
    if (task.assigneeId !== callerUid) {
      return NextResponse.json({ error: 'Only the task assignee can delegate' }, { status: 403 });
    }

    const totalTaskPoints = task.points || 0;
    const stepsPoints = workflowSteps.reduce((sum, s) => sum + (s.points || 0), 0);
    
    if (stepsPoints + (pointsKept || 0) !== totalTaskPoints) {
      return NextResponse.json({ 
        error: `Point mismatch. Total: ${totalTaskPoints}, Sum of steps: ${stepsPoints}, Kept: ${pointsKept || 0}` 
      }, { status: 400 });
    }

    const callerDoc = await db.collection('users').doc(callerUid).get();
    const callerName = callerDoc.data()?.displayName || callerDoc.data()?.email || 'Unknown';

    const workflowId = `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workflowTitle = `[Orchestrated] ${task.title}`;

    const parentDeadline = task.deadline?.toDate?.() || task.deadline;
    const finalDeadline = parentDeadline && new Date(parentDeadline).getTime() > Date.now()
      ? new Date(parentDeadline)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const stepDeadlines = calculateWorkflowDeadlines(finalDeadline, workflowSteps.length);
    const participantIds = new Set<string>([callerUid]);
    const createdTaskIds: string[] = [];

    const batch = db.batch();

    // Fetch subordinate details for email notifications
    const subIds = workflowSteps.map(s => s.assigneeId);
    const usersSnap = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', subIds).get();
    const userDetailsMap = new Map();
    usersSnap.docs.forEach(d => userDetailsMap.set(d.id, d.data()));

    for (let i = 0; i < workflowSteps.length; i++) {
      const step = workflowSteps[i];
      participantIds.add(step.assigneeId);
      const subTaskRef = db.collection('tasks').doc();
      const subTaskLink = `/profile/unified?uid=${step.assigneeId}&task=${subTaskRef.id}`;

      batch.set(subTaskRef, {
        title: step.title,
        description: step.description,
        assignerId: callerUid,
        assigneeId: step.assigneeId,
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

      batch.set(db.collection('users').doc(step.assigneeId), {
        tasksAssignedCount: admin.firestore.FieldValue.increment(1),
        lastTaskAssignedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      batch.set(db.collection('users').doc(step.assigneeId).collection('notifications').doc(), {
        type: 'task_delegation',
        title: 'New Mission Assignment',
        body: `${callerName} assigned you a mission step in "${task.title}".`,
        link: subTaskLink,
        taskId: subTaskRef.id,
        isRead: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      // TRIGGER EMAIL
      const subUser = userDetailsMap.get(step.assigneeId);
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

    await batch.commit();
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

    const callerUid = (auth.user as any).uid;
    const taskRef = db.collection('tasks').doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const task = taskSnap.data()!;
    const delegation = task.delegation;

    if (!delegation || delegation.status !== 'pending') {
      return NextResponse.json({ error: 'No pending delegation' }, { status: 400 });
    }

    if (delegation.delegatedTo !== callerUid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'accept') {
      await taskRef.update({ 'delegation.status': 'accepted', 'delegation.respondedAt': new Date() });
      return NextResponse.json({ success: true, status: 'accepted' });
    } else {
      await taskRef.update({ 'delegation.status': 'rejected', 'delegation.respondedAt': new Date() });
      return NextResponse.json({ success: true, status: 'rejected' });
    }
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to respond to delegation' }, { status: 500 });
  }
}
