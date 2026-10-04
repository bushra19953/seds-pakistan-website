import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { canValidateTask } from '@/lib/server/hierarchy';

/**
 * GET /api/tasks/review-queue
 *
 * Returns tasks with status `submitted-for-review` that the caller is
 * authorized to validate: anyone above the submitter in the reporting
 * chain, the original assigner, or a canManageTasks holder.
 * The caller's own submissions are never included.
 *
 * Server-side only: Firestore rules cannot walk the reporting chain, so
 * clients must use this endpoint instead of querying directly.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface QueueItem {
  id: string;
  title: string;
  submitterUid: string;
  submitterName: string;
  submitterRole: string;
  workflowId?: string;
  sequenceIndex?: number;
  points?: number;
  submittedAt?: string;
  deadline?: string;
  via: 'chain' | 'assigner' | 'role';
  depth: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const callerUid = auth.user.userId as string;
    const callerRole = String(auth.user.role || '');

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const snapshot = await db
      .collection('tasks')
      .where('status', '==', 'submitted-for-review')
      .orderBy('submittedAt', 'desc')
      .limit(100)
      .get()
      .catch(async () => {
        // Fall back when submittedAt is missing on legacy docs.
        return db.collection('tasks').where('status', '==', 'submitted-for-review').limit(100).get();
      });

    const items: QueueItem[] = [];
    const nameCache = new Map<string, { name: string; role: string }>();

    const resolveSubmitter = async (uid: string) => {
      if (nameCache.has(uid)) return nameCache.get(uid)!;
      try {
        const snap = await db.collection('users').doc(uid).get();
        const data = snap.exists ? snap.data() : undefined;
        const entry = {
          name: data?.displayName || data?.email || 'Team Member',
          role: data?.role || data?.displayRole || '',
        };
        nameCache.set(uid, entry);
        return entry;
      } catch {
        const entry = { name: 'Team Member', role: '' };
        nameCache.set(uid, entry);
        return entry;
      }
    };

    for (const doc of snapshot.docs) {
      const task = doc.data() || {};
      const submittedBy = typeof task.submittedBy === 'string' ? task.submittedBy : '';
      if (submittedBy && submittedBy === callerUid) continue; // never validate own work

      let check;
      try {
        check = await canValidateTask(callerUid, callerRole, task as any);
      } catch (e) {
        console.warn('[review-queue] validation check failed for task', doc.id, e);
        continue;
      }
      if (!check.allowed) continue;

      const submitterUid =
        submittedBy || String(task.assigneeId || (Array.isArray(task.assigneeIds) ? task.assigneeIds[0] : '') || '');
      const submitter = submitterUid ? await resolveSubmitter(submitterUid) : { name: 'Team Member', role: '' };

      const toIso = (v: any): string | undefined => {
        try {
          if (!v) return undefined;
          if (typeof v.toDate === 'function') return v.toDate().toISOString();
          const d = new Date(v);
          return isNaN(d.getTime()) ? undefined : d.toISOString();
        } catch {
          return undefined;
        }
      };

      items.push({
        id: doc.id,
        title: String(task.title || 'Untitled task'),
        submitterUid,
        submitterName: submitter.name,
        submitterRole: submitter.role,
        workflowId: task.workflowId ? String(task.workflowId) : undefined,
        sequenceIndex: typeof task.sequenceIndex === 'number' ? task.sequenceIndex : undefined,
        points: typeof task.points === 'number' ? task.points : undefined,
        submittedAt: toIso(task.submittedAt),
        deadline: toIso(task.individualDeadline ?? task.deadline),
        via: check.via || 'role',
        depth: check.depth ?? null,
      });
    }

    return NextResponse.json({ tasks: items });
  } catch (error) {
    console.error('[review-queue] GET failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
