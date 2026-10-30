import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import {
  resolveTasksSupaAdapter,
  listTasksDocs,
  type SeamSnapshotDoc,
} from '@/lib/supa/seam-tasks-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/mission-board — the seam read behind the public
 * projects page's National Mission Board and roadmap task counts
 * (client seam: src/lib/mission-board.ts). Read-bleed fix train 2
 * (rbt2-projects).
 *
 * OLD READ SHAPES (client-side Firestore, per projects-page mount):
 *  - Board: onSnapshot(query(tasks, where('workflowId','!=',null)))
 *    with NO limit — initial snapshot = EVERY workflow task in the
 *    system (one read per doc), then +1 read per changed task doc
 *    per open tab, for the life of the tab, on every task write
 *    anywhere. Public page, anonymous traffic included.
 *  - Roadmap: useCollection(query(tasks, where('projectId','==',id)))
 *    with NO limit — one unbounded list per dialog open.
 *
 * NEW READ SHAPES (this route; tasks is Supabase-PRIMARY, so these
 * reads land on Supabase through the tasks seam and cost ZERO
 * Firestore reads):
 *  - Board mode (no query params): one bounded seam list leg,
 *    where workflowId != null, limit MISSION_BOARD_TASK_LIMIT.
 *    Worst case per fetch: 0 Firestore reads, <= 5000 Supabase rows
 *    server-side, projected to the 11 fields the board renders.
 *    The client fetches once per mount and then polls through the
 *    shared 5-minute-floor hook (paused in hidden tabs), so the
 *    per-tab cost is bounded and read-free against Firestore.
 *  - Project mode (?projectId=<id>): one bounded seam list leg,
 *    where projectId == id, limit PROJECT_TASKS_LIMIT, projected to
 *    { id, status } (the roadmap dialog renders only status-bucket
 *    counts). Worst case per fetch: 0 Firestore reads, <= 2000
 *    Supabase rows server-side.
 *
 * GATING / FALLBACK: the route serves only when the tasks Supabase
 * surface resolves an adapter (SUPA_SURFACES names 'tasks' and the
 * adapter is configured); otherwise 404, and the client keeps its
 * exact pre-fix Firestore listener/query. A seam read failure is a
 * 500 — the client treats every non-200 as "fall back", never as an
 * empty board. Flag OFF is therefore byte-identical to the old page.
 *
 * AUTHORIZATION mirrors what the Firestore rules + query semantics
 * already produce on the client paths this replaces:
 *  - Board mode is public: firestore.rules grants read/list on
 *    tasks where resource.data.workflowId != null to everyone
 *    ("Public visibility for national missions"), which is exactly
 *    the set this mode returns. The field projection below is a
 *    whitelist: internal task fields never leave the server.
 *  - Project mode is NOT public: a projectId == list query is only
 *    runnable under the rules by a super admin or a canManageTasks
 *    holder (the rules cannot prove every matching doc readable for
 *    anyone else, so the query is denied wholesale — that denial is
 *    what renders the dialog's "visible to members" message today).
 *    This mode therefore requires authentication (401) and the
 *    canManageTasks permission (403), checked exactly as
 *    GET /api/tasks/all checks it. Everyone else falls back to the
 *    Firestore query and gets the identical denial/message.
 *
 * BOUNDS ARE CONTRACTS, NOT SILENT TRUNCATION (the /api/tasks/all
 * precedent): if the workflow-task set ever exceeds
 * MISSION_BOARD_TASK_LIMIT, the board mode returns the first
 * MISSION_BOARD_TASK_LIMIT docs in (workflowId, id) order and the
 * board under-reports until the bound is raised — the same
 * documented-cap shape the admin all-tasks endpoint ships with.
 * The cap is 2.5x that endpoint's maximum and 10x the current
 * workflow-task population's order of magnitude.
 */

const MISSION_BOARD_TASK_LIMIT = 5000;
const PROJECT_TASKS_LIMIT = 2000;

/**
 * Board mode is public and slow-changing (the client itself polls on
 * a 5-minute floor), so its successful responses carry the same
 * shared-cache pattern as the hierarchy feed (s-maxage=120 +
 * stale-while-revalidate=60): a shared cache in front of the origin
 * absorbs repeat board loads inside the freshness window instead of
 * every tab paying a full seam read. Project mode is auth-gated and
 * must never be shared-cached, so it returns no Cache-Control at
 * all. Errors (404/500) likewise carry none, so a failure is never
 * cached as if it were the board.
 */
const BOARD_CACHE_CONTROL =
  'public, s-maxage=120, stale-while-revalidate=60';

/** Fields the National Mission Board aggregation reads — no more. */
const BOARD_FIELDS = [
  'workflowId',
  'workflowTitle',
  'chapterName',
  'chapterId',
  'status',
  'assigneeId',
  'assigneeName',
  'assigneePhoto',
  'title',
  'updatedAt',
] as const;

function projectBoardTask(doc: SeamSnapshotDoc): Record<string, any> {
  const data = doc.data();
  const out: Record<string, any> = { id: doc.id };
  for (const field of BOARD_FIELDS) {
    out[field] = data[field] ?? null;
  }
  return out;
}

/**
 * Firestore's '!=' query order: the inequality field ascending,
 * then document id ascending. The board aggregation is
 * order-sensitive (first task per workflow supplies its title and
 * chapter fields; participant and recent-activity order derive from
 * it), so the seam result is sorted into the same order here.
 */
function byWorkflowThenId(a: Record<string, any>, b: Record<string, any>): number {
  const wa = String(a.workflowId ?? '');
  const wb = String(b.workflowId ?? '');
  if (wa !== wb) return wa < wb ? -1 : 1;
  if (a.id === b.id) return 0;
  return String(a.id) < String(b.id) ? -1 : 1;
}

export async function GET(request: NextRequest) {
  const adapter = await resolveTasksSupaAdapter();
  if (!adapter) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const projectId = new URL(request.url).searchParams.get('projectId');

  try {
    if (projectId) {
      // --- Project mode: roadmap status buckets (manager-gated) ---
      const authResult = await verifyAuthentication(request);
      if (!authResult.authenticated || !authResult.user) {
        return NextResponse.json(
          { error: authResult.error || 'Unauthorized' },
          { status: 401 },
        );
      }
      const decoded: any = authResult.user.user || {};
      let canManage = !!(
        (decoded.permissions && decoded.permissions.manageTasks === true) ||
        decoded.manageTasks === true ||
        decoded.canManageTasks === true
      );
      if (!canManage) {
        const db = getDb();
        if (db && decoded.uid) {
          canManage = await hasServerPermissionForUser(
            db,
            decoded.uid,
            'canManageTasks',
          );
        }
      }
      if (!canManage) {
        return NextResponse.json(
          { error: 'Forbidden: insufficient privileges' },
          { status: 403 },
        );
      }

      const docs = await listTasksDocs(adapter, {
        where: [['projectId', '==', projectId]],
        limit: PROJECT_TASKS_LIMIT,
      });
      const tasks = docs
        .map((d) => ({ id: d.id, status: d.data().status ?? null }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return NextResponse.json({ tasks, limit: PROJECT_TASKS_LIMIT });
    }

    // --- Board mode: all workflow tasks (public per firestore.rules) ---
    const docs = await listTasksDocs(adapter, {
      where: [['workflowId', '!=', null]],
      limit: MISSION_BOARD_TASK_LIMIT,
    });
    const tasks = docs.map(projectBoardTask).sort(byWorkflowThenId);
    return NextResponse.json(
      { tasks, limit: MISSION_BOARD_TASK_LIMIT },
      { headers: { 'Cache-Control': BOARD_CACHE_CONTROL } },
    );
  } catch (e: any) {
    console.error('[api/public/mission-board] seam read failed:', e);
    return NextResponse.json(
      { error: e?.message || 'Failed to load mission board tasks' },
      { status: 500 },
    );
  }
}
