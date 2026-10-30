'use client';

/**
 * mission-board — client seam for the National Mission Board and the
 * project roadmap task counts on the public projects page
 * (src/app/projects/page.tsx). Read-bleed fix train 2 (rbt2-projects).
 *
 * THE BURN THIS REMOVES: the projects page used to open a raw
 * Firestore onSnapshot listener on
 *   query(collection 'tasks', where('workflowId', '!=', null))
 * with NO limit, on a PUBLIC page. Every page view paid one read per
 * workflow task in the whole system on mount, plus one read per
 * changed task doc for as long as the tab stayed open, on every task
 * write anywhere. A second unbounded query (tasks where
 * projectId == <roadmap project>) ran per roadmap dialog open.
 *
 * THE FIX (house seam pattern, identical to the projects list on the
 * same page): when the client 'tasks' surface is ON
 * (NEXT_PUBLIC_SUPA_SURFACES names 'tasks'), the page reads through
 * GET /api/public/mission-board instead. That route resolves the
 * tasks Supabase adapter (tasks is Supabase-PRIMARY), so the reads
 * land on Supabase, not on the shared Firestore quota: ZERO Firestore
 * reads per mount and per poll. The board refreshes through the
 * shared usePollingRefresh hook (5-minute floor, paused while the
 * tab is hidden, one refresh on return).
 *
 * FALLBACK CONTRACT (identical to every other converted surface):
 * flag OFF, route 404/401/403/500, or any fetch error -> the caller
 * falls back to the EXACT pre-fix Firestore listener/query, so the
 * rendered output is byte-identical for every viewer class:
 *  - board: the route projects exactly the fields the aggregation
 *    below reads, in the same (workflowId, id) order the Firestore
 *    '!=' query returns, and computeMissionStats is the page's own
 *    aggregation code moved here verbatim — both paths run it.
 *  - roadmap: the route serves project tasks only to callers the
 *    Firestore rules effectively allow to run that list query
 *    (canManageTasks); everyone else gets 401/403 and falls back to
 *    the Firestore query, which denies them exactly as today and
 *    renders the same "visible to members" message.
 *
 * Timestamp reality: over the route's JSON, updatedAt arrives as
 * { seconds, nanoseconds } (the seam's SeamTimestamp shape with its
 * methods dropped by serialization), an ISO string, or an epoch
 * number. reviveBoardTimestamp restores a real Firestore Timestamp
 * so the aggregation's .toMillis() sort runs unchanged.
 */

import { Timestamp } from 'firebase/firestore';
import { isClientSupaSurfaceOn } from './client-supa-flags';
import { isStepWorkDone } from './workflow-progress';
import { getCurrentUserIdToken } from './projects-supa';

/** The Supabase surface this conversion rides on (tasks cluster T). */
export const MISSION_BOARD_TASKS_SURFACE = 'tasks';

/** Client hint: the NEXT_PUBLIC_ twin of the server 'tasks' surface. */
export function missionBoardSupaClientEnabled(): boolean {
  return isClientSupaSurfaceOn(MISSION_BOARD_TASKS_SURFACE);
}

/**
 * Restore a Firestore Timestamp from any JSON-carried shape of one.
 * Values that already expose toMillis() pass through untouched;
 * unrecognized values pass through untouched as well (the
 * aggregation's `?.toMillis?.() || 0` guard treats them as 0,
 * exactly as it treats a missing updatedAt on the Firestore path).
 */
export function reviveBoardTimestamp(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value.toMillis === 'function') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : Timestamp.fromMillis(ms);
  }
  if (typeof value === 'number') {
    return Timestamp.fromMillis(value);
  }
  if (typeof value === 'object') {
    const seconds =
      typeof value.seconds === 'number'
        ? value.seconds
        : typeof value._seconds === 'number'
          ? value._seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof value.nanoseconds === 'number'
          ? value.nanoseconds
          : typeof value._nanoseconds === 'number'
            ? value._nanoseconds
            : 0;
      return Timestamp.fromMillis(seconds * 1000 + Math.floor(nanos / 1e6));
    }
  }
  return value;
}

/**
 * Fetch the workflow-task set for the National Mission Board from
 * GET /api/public/mission-board. Throws on any non-200 response so
 * the caller falls back to its Firestore listener. Returned tasks
 * carry a revived Timestamp on updatedAt; every other field is the
 * route's projection of the task doc.
 */
export async function fetchMissionBoardTasksViaRoute(): Promise<any[]> {
  const res = await fetch('/api/public/mission-board');
  if (!res.ok) throw new Error(`mission-board route ${res.status}`);
  const body = await res.json();
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  return tasks.map((t: any) => ({
    ...t,
    updatedAt: reviveBoardTimestamp(t?.updatedAt),
  }));
}

/**
 * Fetch one project's tasks (the roadmap dialog's status buckets)
 * from GET /api/public/mission-board?projectId=. Sends the current
 * user's ID token when signed in; the route enforces the
 * canManageTasks gate server-side. Throws on any non-200 response
 * so the caller falls back to its Firestore query.
 */
export async function fetchProjectTasksViaRoute(
  projectId: string,
): Promise<any[]> {
  const token = await getCurrentUserIdToken();
  const res = await fetch(
    `/api/public/mission-board?projectId=${encodeURIComponent(projectId)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!res.ok) throw new Error(`mission-board project route ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.tasks) ? body.tasks : [];
}

export interface MissionBoardStats {
  activeMissions: number;
  readiness: number;
  activeChapters: number;
  workflows: any[];
  recentActivity: any[];
}

/**
 * The National Mission Board aggregation, moved verbatim from the
 * projects page's Firestore listener so the Firestore path and the
 * seam path run the identical computation over the identical task
 * shape ({ id, ...data }). Do not "improve" the semantics here:
 * first-task-per-workflow supplies title/chapter fields, readiness
 * is computed over ALL tasks passed in (not only grouped ones),
 * participants dedupe by assigneeId in first-seen order and drop
 * nameless entries, workflows sort by progress descending (stable),
 * and recentActivity is the top 3 by updatedAt descending.
 */
export function computeMissionStats(tasks: any[]): MissionBoardStats {
  const wfMap: Record<string, any> = {};
  const chaptersSet = new Set();

  tasks.forEach((t: any) => {
    if (!t.workflowId) return;
    if (!wfMap[t.workflowId]) {
      wfMap[t.workflowId] = {
        id: t.workflowId,
        title: t.workflowTitle || 'Unnamed Mission',
        chapterName: t.chapterName || '',
        chapterId: t.chapterId || '',
        tasks: [],
        participants: []
      };
    }
    wfMap[t.workflowId].tasks.push(t);
    if (t.chapterId) chaptersSet.add(t.chapterId);
  });

  const workflows = Object.values(wfMap).map((wf: any) => {
    const total = wf.tasks.length;
    const completed = wf.tasks.filter((t: any) => isStepWorkDone(t.status)).length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const participants = Array.from(new Map(
      wf.tasks.map((t: any) => [t.assigneeId, { name: t.assigneeName, photo: t.assigneePhoto }])
    ).values()).filter((p: any) => !!p.name);
    return { ...wf, progress, participants };
  });

  const totalTasks = tasks.length;
  const totalCompleted = tasks.filter((t: any) => isStepWorkDone(t.status)).length;
  const readiness = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;
  const sorted = [...tasks].sort((a: any, b: any) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

  return {
    activeMissions: workflows.length,
    readiness,
    activeChapters: chaptersSet.size,
    workflows: workflows.sort((a, b) => b.progress - a.progress),
    recentActivity: sorted.slice(0, 3)
  };
}
