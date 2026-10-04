import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';

/**
 * Sets all Task 02 step-task deadlines to the given ISO datetime.
 * Pass { deadline: "2026-10-05T20:00:00+05:00" } in the POST body.
 * Updates both `deadline` and `individualDeadline` so list views,
 * detail views, and reminder crons all agree.
 */
const TASK02_TITLE = 'Executive 4-Page Portfolio & Institutional Endorsement Letter Procurement (5 Sets + 3 Letters)';

export async function POST(req: NextRequest) {
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const allowed = await hasServerPermission(auth.user.role || '', 'canManageTasks');
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden: 'canManageTasks' required" }, { status: 403 });
  }

  let deadlineIso: string;
  try {
    const body = await req.json();
    deadlineIso = String(body.deadline || '');
    if (!deadlineIso || isNaN(Date.parse(deadlineIso))) {
      return NextResponse.json({ ok: false, error: 'Provide a valid ISO deadline in POST body, e.g. {"deadline":"2026-10-05T20:00:00+05:00"}' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Provide a valid ISO deadline in POST body, e.g. {"deadline":"2026-10-05T20:00:00+05:00"}' }, { status: 400 });
  }

  ensureAdminInitialized();
  const db = getDb();
  if (!db) {
    return NextResponse.json({ ok: false, error: 'Firestore not initialized' }, { status: 500 });
  }

  const tasksSnap = await db.collection('tasks').where('workflowTitle', '==', TASK02_TITLE).get();
  if (tasksSnap.empty) {
    return NextResponse.json({ ok: false, error: 'Task 02 step tasks not found' }, { status: 404 });
  }

  const updated: string[] = [];
  for (const doc of tasksSnap.docs) {
    await doc.ref.update({
      deadline: deadlineIso,
      individualDeadline: deadlineIso,
      updatedAt: new Date().toISOString(),
    });
    updated.push(doc.id);
  }

  return NextResponse.json({ ok: true, deadline: deadlineIso, tasksUpdated: updated });
}
