import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';

/**
 * Deterministic backfill: attach the 6 Task 02 Drive resource links to each
 * of the 3 workflow step tasks. Idempotent: skips URLs already present.
 *
 * The links were referenced in the task description as plain text
 * ("the provided Google Drive link") but never stored as clickable resources,
 * so the PDF export had nothing to render. This migration writes them into
 * the `resources` array that the UI and PDF both read.
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
  const wfSnap = await db.collection('workflows').where('title', '==', TASK02_TITLE).limit(1).get();
  if (wfSnap.empty) {
    return NextResponse.json({ ok: false, error: 'Task 02 workflow not found' }, { status: 404 });
  }
  const wfId = wfSnap.docs[0].id;

  const tasksSnap = await db.collection('tasks').where('workflowId', '==', wfId).get();
  const results: Array<{ id: string; title: string; added: number; skipped: number }> = [];

  for (const doc of tasksSnap.docs) {
    const data = doc.data() as any;
    const existing: Array<{ url?: string }> = Array.isArray(data.resources) ? data.resources : [];
    const existingUrls = new Set(existing.map((r) => String(r?.url || '')));
    const toAdd = TASK02_RESOURCES.filter((r) => !existingUrls.has(r.url));
    if (toAdd.length > 0) {
      await doc.ref.update({
        resources: [...existing, ...toAdd],
        updatedAt: new Date().toISOString(),
      });
    }
    results.push({ id: doc.id, title: data.title || '', added: toAdd.length, skipped: TASK02_RESOURCES.length - toAdd.length });
  }

  return NextResponse.json({ ok: true, workflowId: wfId, tasks: results });
}
