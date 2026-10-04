import type { Firestore, DocumentReference } from 'firebase-admin/firestore';

/**
 * Cascade deletion for workflows.
 *
 * A workflow is a virtual aggregate, not a document: it is the set of
 * `tasks` docs sharing a `workflowId` string, plus `workflow_members` docs
 * with id `{workflowId}_{uid}`. Deleting a workflow therefore means deleting
 * those task docs and member docs. Writes are chunked to stay under the
 * Firestore 500-operation batch limit.
 */

export async function collectWorkflowDeletions(
  db: Firestore,
  workflowId: string
): Promise<{ taskRefs: DocumentReference[]; memberRefs: DocumentReference[] }> {
  const tasksSnap = await db.collection('tasks').where('workflowId', '==', workflowId).get();
  const taskRefs = tasksSnap.docs.map((d) => d.ref);

  const prefix = `${workflowId}_`;
  const membersSnap = await db.collection('workflow_members').get();
  const memberRefs = membersSnap.docs
    .filter((d) => d.id.startsWith(prefix))
    .map((d) => d.ref);

  return { taskRefs, memberRefs };
}

export async function deleteWorkflowCascade(
  db: Firestore,
  workflowId: string
): Promise<{ deletedTasks: number; deletedMembers: number }> {
  const { taskRefs, memberRefs } = await collectWorkflowDeletions(db, workflowId);
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

  return { deletedTasks: taskRefs.length, deletedMembers: memberRefs.length };
}
