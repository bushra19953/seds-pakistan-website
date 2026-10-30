import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { canValidateTask } from '@/lib/server/hierarchy';
import { getUserDocViaSeam, listTasksViaSeam } from '@/lib/supa/seam-tasks-lists';

/**
 * GET /api/tasks/review-queue
 *
 * Returns tasks with status `submitted-for-review` that the caller is
 * authorized to validate: anyone above the submitter in the reporting
 * chain, the task's named reviewer, the original assigner, or a
 * canManageTasks holder.
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
  via: 'chain' | 'assigner' | 'role' | 'reviewer';
  depth: number | null;
  description?: string;
  report?: string;
  deliverableFiles?: Array<{ fileName?: string; downloadUrl: string; sizeBytes?: number; contentType?: string }>;
  resourceLinks?: string;
  hoursWorked?: number;
  workflowTitle?: string;
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

    // Supa path (flag ON): the same status filter, submittedAt-desc order
    // and 100 cap via the seam. Seam null (flag OFF / adapter absent /
    // adapter error) uses the Firestore query below verbatim, including
    // its no-order fallback for legacy docs missing submittedAt. Note the
    // one deliberate divergence: the adapter orders by the text
    // extraction of submittedAt and has no equivalent of the Firestore
    // order-failure fallback; see supa-rebase-notes/tasks-2.md.
    let snapshot: any = await listTasksViaSeam(
      [['status', '==', 'submitted-for-review']],
      { orderBy: { field: 'submittedAt', direction: 'desc' }, limit: 100 },
    );
    if (!snapshot) {
      snapshot = await db
        .collection('tasks')
        .where('status', '==', 'submitted-for-review')
        .orderBy('submittedAt', 'desc')
        .limit(100)
        .get()
        .catch(async () => {
          // Fall back when submittedAt is missing on legacy docs.
          // Census 04 T5: this second fallback is itself CAUGHT — its
          // failure used to escape as an uncaught 500 under
          // RESOURCE_EXHAUSTED. Both Firestore shapes failing serves
          // the degraded empty queue (the queue renders null on
          // empty), loudly logged so a quota-empty queue is
          // distinguishable from a genuinely empty one.
          try {
            return await db.collection('tasks').where('status', '==', 'submitted-for-review').limit(100).get();
          } catch (fallbackError) {
            console.error('[review-queue] Both Firestore queue reads failed; serving a degraded empty queue', fallbackError);
            return null;
          }
        });
      if (!snapshot) {
        return NextResponse.json({ tasks: [], degraded: true });
      }
    }

    const items: QueueItem[] = [];
    const nameCache = new Map<string, { name: string; role: string }>();

    const resolveSubmitter = async (uid: string) => {
      if (nameCache.has(uid)) return nameCache.get(uid)!;
      try {
        const seamSnap = await getUserDocViaSeam(uid);
        const snap = seamSnap ?? await db.collection('users').doc(uid).get();
        const data = snap.exists ? snap.data() : undefined;
        const entry = {
          name: data?.displayName || 'Team Member',
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
        description: typeof task.description === 'string' ? task.description : undefined,
        report: typeof task.report === 'string' ? task.report : undefined,
        deliverableFiles: Array.isArray(task.deliverableFiles)
          ? task.deliverableFiles
              .filter((f: any) => f && typeof f.downloadUrl === 'string')
              .map((f: any) => ({
                fileName: f.fileName,
                downloadUrl: f.downloadUrl,
                sizeBytes: f.sizeBytes,
                contentType: f.contentType,
              }))
          : undefined,
        resourceLinks: typeof task.resourceLinks === 'string' ? task.resourceLinks : undefined,
        hoursWorked: typeof task.hoursWorked === 'number' ? task.hoursWorked : undefined,
        workflowTitle: typeof task.workflowTitle === 'string' ? task.workflowTitle : undefined,
      });
    }

    return NextResponse.json({ tasks: items });
  } catch (error) {
    console.error('[review-queue] GET failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
