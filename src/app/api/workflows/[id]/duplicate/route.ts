import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { logWorkflowAudit } from '@/lib/server/workflow-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Submission and review fields that must not carry over to a fresh draft copy.
const CLEARED_FIELDS = [
  'report',
  'hoursWorked',
  'deliverableFiles',
  'completedAt',
  'feedback',
  'feedback_text',
  'approvedAt',
  'approvedBy',
  'reviewedAt',
  'reviewedBy',
];

function newWorkflowId(): string {
  return `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }

    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!(await hasServerPermission(auth.user.role || '', 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ ok: false, error: 'Workflow id is required' }, { status: 400 });
    }

    // A workflow is the set of tasks sharing a workflowId string.
    const sourceSnap = await db.collection('tasks').where('workflowId', '==', id).get();
    if (sourceSnap.empty) {
      return NextResponse.json({ ok: false, error: 'Workflow not found' }, { status: 404 });
    }

    const sourceTasks = sourceSnap.docs
      .map((d) => ({ ref: d.ref, data: d.data() as any }))
      .sort((a, b) => (a.data.sequenceIndex ?? 0) - (b.data.sequenceIndex ?? 0));

    const newId = newWorkflowId();
    const sourceTitle = String(sourceTasks[0].data.workflowTitle || sourceTasks[0].data.title || 'Workflow');
    const newTitle = `Copy of ${sourceTitle}`;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const taskIds: string[] = [];
    const batch = db.batch();

    for (const { data } of sourceTasks) {
      const clone: Record<string, unknown> = { ...data };
      for (const f of CLEARED_FIELDS) delete clone[f];
      clone.workflowId = newId;
      clone.workflowTitle = newTitle;
      clone.status = 'pending';
      clone.isCurrentStep = (data.sequenceIndex ?? 0) === 0;
      clone.releasedAt = null;
      clone.createdAt = now;
      clone.updatedAt = now;
      clone.duplicatedFrom = id;

      const newRef = db.collection('tasks').doc();
      batch.set(newRef, clone);
      taskIds.push(newRef.id);
    }

    // Copy membership under the new workflow id; the duplicator becomes owner.
    const duplicatorUid = auth.user.userId;
    const memberIds = new Set<string>();
    const membersSnap = await db.collection('workflow_members').get();
    for (const d of membersSnap.docs) {
      if (!d.id.startsWith(`${id}_`)) continue;
      const uid = String((d.data() as any)?.userId || d.id.slice(id.length + 1));
      if (!uid) continue;
      memberIds.add(uid);
    }
    memberIds.add(duplicatorUid);
    for (const uid of memberIds) {
      const memberRef = db.collection('workflow_members').doc(`${newId}_${uid}`);
      batch.set(memberRef, {
        workflowId: newId,
        userId: uid,
        joinedAt: now,
        role: uid === duplicatorUid ? 'owner' : 'member',
      }, { merge: true });
    }

    await batch.commit();

    await logWorkflowAudit(db, {
      action: 'workflow_duplicated',
      workflowId: newId,
      actorUid: duplicatorUid,
      details: { sourceWorkflowId: id, taskCount: taskIds.length },
    });

    return NextResponse.json({ ok: true, workflowId: newId, taskIds });
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
