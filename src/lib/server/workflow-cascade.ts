import type { Firestore, DocumentReference } from 'firebase-admin/firestore';
import {
  filterWorkflowMemberIds,
  listWorkflowMembersViaSupa,
} from './workflow-members-supa';
import {
  mirrorWorkflowMemberDeletesByIds,
  mirrorWorkflowTaskDeletesByIds,
} from './workflow-write-mirror';

/**
 * Cascade deletion for workflows.
 *
 * A workflow is a virtual aggregate, not a document: it is the set of
 * `tasks` docs sharing a `workflowId` string, plus `workflow_members` docs
 * with id `{workflowId}_{uid}`. Deleting a workflow therefore means deleting
 * those task docs and member docs. Writes are chunked to stay under the
 * Firestore 500-operation batch limit.
 *
 * Supa migration (group wf-4, see supa-rebase-notes/wf-4.md item M7):
 * the member LISTING is a one-shot read and goes through the
 * workflow-members seam behind the 'workflows' flag — member refs are
 * then constructed with `collection().doc(id)` (constructing a ref is
 * not a read). On any seam miss (flag OFF, unconfigured, adapter
 * error) a Firestore fallback runs — since read-bleed train 2 that
 * fallback is a documentId prefix-range read of this workflow's own
 * members (see below), never the original full-collection `.get()`.
 * The returned ref set, counts, and the batch deletion below are
 * unchanged; deletion itself stays on Firestore.
 */

/** Hard bound for one workflow's step tasks in the cascade. */
export const CASCADE_STEPS_LIMIT = 500;
/** Hard bound for one workflow's member docs in the cascade. */
export const CASCADE_MEMBERS_LIMIT = 1000;

export async function collectWorkflowDeletions(
  db: Firestore,
  workflowId: string,
  prefetchedTaskRefs?: DocumentReference[]
): Promise<{ taskRefs: DocumentReference[]; memberRefs: DocumentReference[] }> {
  // Census 05, unbounded list #5: the steps leg is bounded, and
  // callers that already read the step refs for their own guards
  // pass them in so the steps are not read twice per delete.
  let taskRefs: DocumentReference[];
  if (prefetchedTaskRefs) {
    taskRefs = prefetchedTaskRefs;
  } else {
    const tasksSnap = await db.collection('tasks').where('workflowId', '==', workflowId).limit(CASCADE_STEPS_LIMIT).get();
    taskRefs = tasksSnap.docs.map((d) => d.ref);
  }

  const prefix = `${workflowId}_`;
  const supaMembers = await listWorkflowMembersViaSupa();
  let memberRefs: DocumentReference[];
  if (supaMembers) {
    memberRefs = filterWorkflowMemberIds(supaMembers, workflowId).map((id) =>
      db.collection('workflow_members').doc(id)
    );
  } else {
    // Census 05, unbounded list #6: this fallback used to be a
    // FULL-collection workflow_members get (every member of every
    // workflow, for one delete). Member doc ids are
    // `{workflowId}_{uid}`, so a documentId prefix RANGE bounds the
    // read to this workflow's own members, hard-limited on top.
    const { FieldPath } = await import('firebase-admin/firestore');
    const membersSnap = await db
      .collection('workflow_members')
      .where(FieldPath.documentId(), '>=', prefix)
      .where(FieldPath.documentId(), '<', `${prefix}`)
      .limit(CASCADE_MEMBERS_LIMIT)
      .get();
    memberRefs = membersSnap.docs
      .filter((d) => d.id.startsWith(prefix))
      .map((d) => d.ref);
  }

  return { taskRefs, memberRefs };
}

export async function deleteWorkflowCascade(
  db: Firestore,
  workflowId: string,
  prefetchedTaskRefs?: DocumentReference[]
): Promise<{ deletedTasks: number; deletedMembers: number }> {
  const { taskRefs, memberRefs } = await collectWorkflowDeletions(db, workflowId, prefetchedTaskRefs);
  const all = [...taskRefs, ...memberRefs];

  // Migration scripts (not the API) sometimes write a `workflows/{id}` doc.
  // Remove it too when present so no orphan survives the cascade. Deleting a
  // nonexistent doc is a no-op, so this is safe for pure task-aggregates.
  const workflowDocRef = db.collection('workflows').doc(workflowId);
  const workflowDocSnap = await workflowDocRef.get();
  const extraRefs = workflowDocSnap.exists ? [workflowDocRef] : [];
  const deletable = [...all, ...extraRefs];

  // Chunked batches: 400 ops per batch keeps us safely under the limit.
  for (let i = 0; i < deletable.length; i += 400) {
    const batch = db.batch();
    for (const ref of deletable.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }

  // MIRROR (workflows surface): remove the same docs from the
  // Supabase mirror the workflow readers consult, so a deleted
  // workflow does not keep resolving steps/members there. Never
  // throws; flag OFF = no-op.
  await mirrorWorkflowTaskDeletesByIds(taskRefs.map((r) => r.id));
  await mirrorWorkflowMemberDeletesByIds(memberRefs.map((r) => r.id));

  return { deletedTasks: taskRefs.length, deletedMembers: memberRefs.length };
}
