import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { logWorkflowAudit } from '@/lib/server/workflow-audit';
import {
  extractWorkflowMemberUids,
  listWorkflowMembersViaSupa,
} from '@/lib/server/workflow-members-supa';
import {
  mirrorWorkflowMemberDocFromData,
  mirrorWorkflowTaskDocFromData,
} from '@/lib/server/workflow-write-mirror';

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
    if (!(await hasServerPermissionForUser(db, auth.user.userId, 'canManageTasks'))) {
      return NextResponse.json({ error: 'Forbidden: task management permission required' }, { status: 403 });
    }

    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ ok: false, error: 'Workflow id is required' }, { status: 400 });
    }

    // A workflow is the set of tasks sharing a workflowId string.
    // Bounded (census 05 unbounded family): one workflow's steps —
    // the largest known workflow has ~23; 500 is a hard ceiling.
    const sourceSnap = await db.collection('tasks').where('workflowId', '==', id).limit(500).get();
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
    const clones: Array<{ id: string; data: Record<string, unknown> }> = [];
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
      clones.push({ id: newRef.id, data: clone });
    }

    // Copy membership under the new workflow id; the duplicator becomes owner.
    const duplicatorUid = auth.user.userId;
    // Supa migration (group wf-4, supa-rebase-notes/wf-4.md item M5):
    // the member listing is a one-shot read served through the
    // workflow-members seam behind the 'workflows' flag when available;
    // on any seam miss the original full-collection Firestore scan runs
    // and the extracted uid set is identical. The member WRITES below
    // stay in this Firestore batch with the cloned tasks.
    const supaMembers = await listWorkflowMembersViaSupa();
    let memberIds: Set<string>;
    if (supaMembers) {
      memberIds = extractWorkflowMemberUids(supaMembers, id);
    } else {
      memberIds = new Set<string>();
      // Read-bleed train 2 (same shape as workflow-cascade): the
      // fallback used to be a FULL-collection workflow_members get.
      // Member doc ids are `{workflowId}_{uid}`, so a documentId
      // prefix RANGE bounds it to this workflow's own members.
      const prefix = `${id}_`;
      const membersSnap = await db
        .collection('workflow_members')
        .where(admin.firestore.FieldPath.documentId(), '>=', prefix)
        .where(admin.firestore.FieldPath.documentId(), '<', `${prefix}`)
        .limit(1000)
        .get();
      for (const d of membersSnap.docs) {
        if (!d.id.startsWith(prefix)) continue;
        const uid = String((d.data() as any)?.userId || d.id.slice(id.length + 1));
        if (!uid) continue;
        memberIds.add(uid);
      }
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

    // MIRROR (workflows surface): cloned steps + members are
    // workflow-owned writes, mirrored exactly like POST
    // /api/workflows creates — otherwise the copy is invisible on
    // the detail/public/PDF surfaces. Never throws; flag OFF =
    // no-op. Payload form (census 23 A5): the clone and member
    // payloads are held in memory from the batch above, so the
    // mirrors cost zero Firestore re-reads. The member payload's
    // joinedAt is the write instant (the batch's serverTimestamp
    // resolves to the same instant on commit).
    for (const clone of clones) {
      // createdAt/updatedAt are serverTimestamp sentinels in the
      // batch payload (dropped by sanitizeForMirror); the mirror
      // payload carries the write instant instead — what a re-read
      // would have returned.
      const held = { ...(clone.data as Record<string, any>), createdAt: new Date(), updatedAt: new Date() };
      await mirrorWorkflowTaskDocFromData(clone.id, held);
    }
    for (const uid of memberIds) {
      const memberId = `${newId}_${uid}`;
      await mirrorWorkflowMemberDocFromData(memberId, {
        workflowId: newId,
        userId: uid,
        joinedAt: new Date(),
        role: uid === duplicatorUid ? 'owner' : 'member',
      });
    }

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
