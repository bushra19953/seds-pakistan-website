import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { canValidateTask } from '@/lib/server/hierarchy';
import { getTaskDocViaSeam } from '@/lib/supa/seam-tasks-lists';

/**
 * GET /api/tasks/[id]/validation
 *
 * Answers "can the caller validate this task right now?" for the task
 * detail dialog. Returns the grant basis so the UI can explain why the
 * viewer sees Approve/Reject.
 *
 * Response: { canValidate, via: 'chain'|'assigner'|'role'|'reviewer'|null, depth, isSubmitter }
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const callerUid = auth.user.userId as string;
    const callerRole = String(auth.user.role || '');
    const { id } = await params;

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }
    // Read via the seam when the 'tasks' surface is ON; seam null (flag
    // OFF / adapter absent / adapter error) falls back to the Firestore
    // get below, unchanged. This route is GET-only: it has no write path
    // (validation DECISIONS are written by other routes, outside this
    // group), so there is nothing to mirror here. canValidateTask keeps
    // reading Firestore internally (hierarchy chain) on both paths.
    const seamSnap = await getTaskDocViaSeam(id);
    const snap = seamSnap ?? await db.collection('tasks').doc(id).get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const task = snap.data() || {};
    const submittedBy = typeof task.submittedBy === 'string' ? task.submittedBy : '';

    let check;
    try {
      check = await canValidateTask(callerUid, callerRole, task as any);
    } catch (e) {
      console.error('[task-validation] check failed for task', id, e);
      return NextResponse.json({ canValidate: false, via: null, depth: null, isSubmitter: submittedBy === callerUid });
    }

    return NextResponse.json({
      canValidate: check.allowed,
      via: check.allowed ? check.via || 'role' : null,
      depth: check.depth ?? null,
      isSubmitter: !!submittedBy && submittedBy === callerUid,
    });
  } catch (error) {
    console.error('[task-validation] GET failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
