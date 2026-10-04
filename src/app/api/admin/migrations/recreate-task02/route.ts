import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';

/**
 * Deterministic Task 02 recreation.
 *
 * The original Task 02 workflow was created before the multi-assignee and
 * resource-link fixes. Instead of hand-editing it, this migration:
 *   1. Reads the current Task 02 workflow and its step tasks.
 *   2. Creates a brand-new workflow + step tasks with:
 *      - the VP (Muhammad Huzaifah Shujjah) as co-assignee on every step
 *        (oversight: verifies Maira's execution),
 *      - the 6 Drive resource links in each step's resources array,
 *      - all other fields (titles, descriptions, deadlines, points) preserved.
 *   3. Deletes the old workflow and task docs only after the new ones exist.
 *
 * Safe to re-run: if a recreated workflow already exists (marked by
 * recreatedFrom), it reports it instead of duplicating.
 */
const TASK02_TITLE = 'Executive 4-Page Portfolio & Institutional Endorsement Letter Procurement (5 Sets + 3 Letters)';

const TASK02_RESOURCES = [
  { type: 'drive', url: 'https://drive.google.com/drive/folders/18m2HyqzQv2CyelgqRvEaxBCUqz3v2KBX', title: 'Task 02 Package Folder (all files)' },
  { type: 'drive', url: 'https://drive.google.com/file/d/1tPVc3o9MM1fRz9K1niXDq_EFqmjb8gah/view?usp=drivesdk', title: 'Master Portfolio Text' },
  { type: 'drive', url: 'https://drive.google.com/file/d/1gwS_VTKeGzDD3Q-HYqIWjVKt5m3Avj0N/view?usp=drivesdk', title: 'Institutional Endorsement Letter' },
  { type: 'drive', url: 'https://drive.google.com/file/d/1EKSm1XvE0GtESnBlENCAQIN7OuoWlaDX/view?usp=drivesdk', title: 'Print Specifications & QC' },
  { type: 'drive', url: 'https://drive.google.com/file/d/1L034sPJQ9_7w7bjGTNn6jo24TiBXLTfA/view?usp=drivesdk', title: 'Meeting Choreography' },
  { type: 'drive', url: 'https://drive.google.com/file/d/1SMfNpzWAoYDpN3aJH13yzSZ-NMkM2YNX/view?usp=drivesdk', title: 'Platform Work Order' },
] as const;

export async function POST(req: NextRequest) {
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const allowed = await hasServerPermission(auth.user.role || '', 'canManageTasks');
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden: 'canManageTasks' required" }, { status: 403 });
  }

  ensureAdminInitialized();
  const db = getDb();
  if (!db) {
    return NextResponse.json({ ok: false, error: 'Firestore not initialized' }, { status: 500 });
  }

  // Resolve Huzaifah's uid from the users collection (do not hardcode).
  const userSnap = await db.collection('users').where('email', '==', 'huzaifahshujjahhs1234@gmail.com').limit(1).get();
  if (userSnap.empty) {
    return NextResponse.json({ ok: false, error: 'Huzaifah user not found' }, { status: 404 });
  }
  const huzaifahUid = userSnap.docs[0].id;

  // Find the current Task 02 workflow.
  const wfSnap = await db.collection('workflows').where('title', '==', TASK02_TITLE).limit(1).get();
  if (wfSnap.empty) {
    return NextResponse.json({ ok: false, error: 'Task 02 workflow not found' }, { status: 404 });
  }
  const oldWfDoc = wfSnap.docs[0];
  const oldWfId = oldWfDoc.id;
  const oldWf = oldWfDoc.data() as any;

  if (oldWf.recreatedFrom) {
    return NextResponse.json({ ok: true, alreadyRecreated: true, workflowId: oldWfId });
  }

  const tasksSnap = await db.collection('tasks').where('workflowId', '==', oldWfId).get();
  if (tasksSnap.empty) {
    return NextResponse.json({ ok: false, error: 'No step tasks found for Task 02' }, { status: 404 });
  }

  // Build the new task docs first (do not delete until these exist).
  const newTaskRefs: FirebaseFirestore.DocumentReference[] = [];
  const taskIdMap = new Map<string, string>();

  for (const doc of tasksSnap.docs) {
    const data = doc.data() as any;
    const primaryUid = String(data.assigneeId || (Array.isArray(data.assigneeIds) ? data.assigneeIds[0] : ''));
    const assigneeIds = Array.from(new Set([primaryUid, huzaifahUid].filter(Boolean)));

    const existing: Array<{ url?: string }> = Array.isArray(data.resources) ? data.resources : [];
    const existingUrls = new Set(existing.map((r) => String(r?.url || '')));
    const resources = [...existing, ...TASK02_RESOURCES.filter((r) => !existingUrls.has(r.url))];

    const newRef = db.collection('tasks').doc();
    const { ...rest } = data;
    delete (rest as any).id;
    await newRef.set({
      ...rest,
      workflowId: '', // patched below once the new workflow exists
      assigneeId: primaryUid,
      assigneeIds,
      resources,
      status: 'pending',
      recreatedFrom: doc.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    newTaskRefs.push(newRef);
    taskIdMap.set(doc.id, newRef.id);
  }

  // Create the new workflow doc.
  const newWfRef = db.collection('workflows').doc();
  const newWfId = newWfRef.id;
  const { ...wfRest } = oldWf;
  delete (wfRest as any).id;
  const newSteps = Array.isArray(oldWf.steps)
    ? oldWf.steps.map((s: any) => {
        const ns = { ...s };
        if (s.taskId && taskIdMap.has(s.taskId)) ns.taskId = taskIdMap.get(s.taskId);
        if (s.id && taskIdMap.has(s.id)) ns.id = taskIdMap.get(s.id);
        return ns;
      })
    : oldWf.steps;
  await newWfRef.set({
    ...wfRest,
    steps: newSteps,
    taskIds: newTaskRefs.map((r) => r.id),
    status: 'pending',
    completedSteps: 0,
    recreatedFrom: oldWfId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Point the new tasks at the new workflow.
  await Promise.all(newTaskRefs.map((r) => r.update({ workflowId: newWfId })));

  // Only now delete the old docs.
  await Promise.all(tasksSnap.docs.map((d) => d.ref.delete()));
  await oldWfDoc.ref.delete();

  return NextResponse.json({
    ok: true,
    oldWorkflowId: oldWfId,
    newWorkflowId: newWfId,
    tasksRecreated: newTaskRefs.map((r) => r.id),
  });
}
