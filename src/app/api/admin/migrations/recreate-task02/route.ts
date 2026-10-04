import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';

/**
 * Deterministic Task 02 recreation.
 *
 * Workflows are virtual: they are derived from tasks sharing a workflowId.
 * There is no separate workflows collection document holding the title.
 * This migration:
 *   1. Finds Task 02 step tasks by their workflowTitle.
 *   2. Creates brand-new task docs under a fresh workflowId with:
 *      - the VP (Muhammad Huzaifah Shujjah) as co-assignee on every step
 *        (oversight: verifies Maira's execution),
 *      - the 6 Drive resource links in each step's resources array,
 *      - all other fields (titles, descriptions, deadlines, points) preserved.
 *   3. Deletes the old task docs only after the new ones exist.
 *
 * Safe to re-run: if tasks already carry recreatedFrom, it reports them.
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

  // Find Task 02 step tasks by workflowTitle (workflows are virtual).
  const tasksSnap = await db.collection('tasks').where('workflowTitle', '==', TASK02_TITLE).get();
  if (tasksSnap.empty) {
    return NextResponse.json({ ok: false, error: 'Task 02 step tasks not found' }, { status: 404 });
  }

  const already = tasksSnap.docs.filter((d) => (d.data() as any).recreatedFrom);
  if (already.length > 0 && already.length === tasksSnap.size) {
    return NextResponse.json({ ok: true, alreadyRecreated: true, count: already.length });
  }

  const oldWorkflowId = (tasksSnap.docs[0].data() as any).workflowId || '';
  const newWorkflowId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Build the new task docs first (do not delete until these exist).
  const created: string[] = [];
  for (const doc of tasksSnap.docs) {
    const data = doc.data() as any;
    if (data.recreatedFrom) continue;
    const primaryUid = String(data.assigneeId || (Array.isArray(data.assigneeIds) ? data.assigneeIds[0] : ''));
    const assigneeIds = Array.from(new Set([primaryUid, huzaifahUid].filter(Boolean)));

    const existing: Array<{ url?: string }> = Array.isArray(data.resources) ? data.resources : [];
    const existingUrls = new Set(existing.map((r) => String(r?.url || '')));
    const resources = [...existing, ...TASK02_RESOURCES.filter((r) => !existingUrls.has(r.url))];

    const newRef = db.collection('tasks').doc();
    const rest = { ...data };
    delete (rest as any).id;
    await newRef.set({
      ...rest,
      workflowId: newWorkflowId,
      assigneeId: primaryUid,
      assigneeIds,
      resources,
      status: 'pending',
      recreatedFrom: doc.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    created.push(newRef.id);
  }

  // Copy workflow_members entries to the new workflowId, then remove old ones.
  if (oldWorkflowId) {
    const membersSnap = await db.collection('workflow_members').where('workflowId', '==', oldWorkflowId).get();
    for (const m of membersSnap.docs) {
      const md = m.data() as any;
      await db.collection('workflow_members').add({ ...md, workflowId: newWorkflowId, createdAt: new Date().toISOString() });
    }
    await Promise.all(membersSnap.docs.map((d) => d.ref.delete()));
  }

  // Only now delete the old task docs.
  await Promise.all(tasksSnap.docs.map((d) => d.ref.delete()));

  return NextResponse.json({
    ok: true,
    oldWorkflowId,
    newWorkflowId,
    tasksRecreated: created,
  });
}
