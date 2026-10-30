/**
 * Project roadmap projection — the grouping behind the project
 * detail page's "Roadmap & Progress" section.
 *
 * Founder acceptance case (2026-10-30): opening a project must show
 * its work as it actually is — each linked workflow as ONE unit with
 * its steps in sequence order (assignees + status on every step),
 * plus the project's standalone tasks. The previous rendering split
 * the flat task list into four status buckets sliced to 5 titles
 * each: workflow steps were scattered across buckets, everything
 * past the slice vanished behind "+ N more", and any status outside
 * the four bucket keys ('submitted-for-review', 'approved') never
 * rendered at all.
 *
 * Contract:
 *  - every input task appears EXACTLY once (in its workflow group,
 *    or in `standalone` when it carries no workflowId);
 *  - steps sort by sequenceIndex when numeric, then by creation
 *    time, then title — the page query has no orderBy, so input
 *    order is arbitrary and must not leak into the rendering;
 *  - a step's people are the union of assigneeId + assigneeIds,
 *    primary first, deduped (the same union the workflow write path
 *    stamps);
 *  - done counts use the canonical isStepWorkDone semantics
 *    (completed / approved / submitted-for-review).
 */
import { isStepWorkDone } from './workflow-progress';

export interface RoadmapStep {
  id: string;
  title: string;
  status: string;
  sequenceIndex: number | null;
  assigneeIds: string[];
}

export interface RoadmapWorkflow {
  workflowId: string;
  workflowTitle: string;
  steps: RoadmapStep[];
  totalSteps: number;
  doneSteps: number;
}

export interface ProjectRoadmap {
  workflows: RoadmapWorkflow[];
  standalone: RoadmapStep[];
  totalTasks: number;
  doneTasks: number;
}

function millisOf(val: any): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (val instanceof Date) return val.getTime();
  if (typeof val.toMillis === 'function') {
    const ms = val.toMillis();
    return typeof ms === 'number' ? ms : null;
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000;
  }
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function assigneeIdsOf(task: Record<string, any>): string[] {
  const raw: any[] = [];
  if (typeof task.assigneeId === 'string' && task.assigneeId) raw.push(task.assigneeId);
  if (Array.isArray(task.assigneeIds)) raw.push(...task.assigneeIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function toStep(task: Record<string, any>): RoadmapStep {
  const seq = task.sequenceIndex;
  return {
    id: String(task.id ?? ''),
    title: typeof task.title === 'string' && task.title ? task.title : 'Untitled task',
    status: typeof task.status === 'string' && task.status ? task.status : 'pending',
    sequenceIndex: typeof seq === 'number' && Number.isFinite(seq) ? seq : null,
    assigneeIds: assigneeIdsOf(task),
  };
}

function compareSteps(a: Record<string, any>, b: Record<string, any>): number {
  const sa = typeof a.sequenceIndex === 'number' ? a.sequenceIndex : null;
  const sb = typeof b.sequenceIndex === 'number' ? b.sequenceIndex : null;
  if (sa !== null && sb !== null && sa !== sb) return sa - sb;
  if (sa !== null && sb === null) return -1;
  if (sa === null && sb !== null) return 1;
  const ca = millisOf(a.createdAt);
  const cb = millisOf(b.createdAt);
  if (ca !== null && cb !== null && ca !== cb) return ca - cb;
  if (ca !== null && cb === null) return -1;
  if (ca === null && cb !== null) return 1;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''));
}

export function buildProjectRoadmap(
  tasks: Array<Record<string, any>> | null | undefined,
): ProjectRoadmap {
  const list = Array.isArray(tasks) ? tasks : [];
  const byWorkflow = new Map<string, Array<Record<string, any>>>();
  const standaloneRaw: Array<Record<string, any>> = [];

  for (const task of list) {
    if (!task || typeof task !== 'object') continue;
    const wf = typeof task.workflowId === 'string' ? task.workflowId : '';
    if (wf) {
      const group = byWorkflow.get(wf);
      if (group) group.push(task);
      else byWorkflow.set(wf, [task]);
    } else {
      standaloneRaw.push(task);
    }
  }

  const workflows: RoadmapWorkflow[] = [];
  for (const [workflowId, group] of byWorkflow.entries()) {
    const sorted = [...group].sort(compareSteps);
    const steps = sorted.map(toStep);
    const titleStep = sorted.find(
      (t) => typeof t.workflowTitle === 'string' && t.workflowTitle,
    );
    workflows.push({
      workflowId,
      workflowTitle: titleStep ? String(titleStep.workflowTitle) : 'Workflow',
      steps,
      totalSteps: steps.length,
      doneSteps: steps.filter((s) => isStepWorkDone(s.status)).length,
    });
  }
  // Earliest workflow first (by its first step's creation time),
  // title as the stable tiebreak.
  workflows.sort((a, b) => {
    const ga = byWorkflow.get(a.workflowId) ?? [];
    const gb = byWorkflow.get(b.workflowId) ?? [];
    const ca = Math.min(
      ...ga.map((t) => millisOf(t.createdAt) ?? Number.MAX_SAFE_INTEGER),
    );
    const cb = Math.min(
      ...gb.map((t) => millisOf(t.createdAt) ?? Number.MAX_SAFE_INTEGER),
    );
    if (ca !== cb) return ca - cb;
    return a.workflowTitle.localeCompare(b.workflowTitle);
  });

  const standalone = [...standaloneRaw].sort(compareSteps).map(toStep);
  const doneTasks =
    workflows.reduce((n, w) => n + w.doneSteps, 0) +
    standalone.filter((s) => isStepWorkDone(s.status)).length;

  return {
    workflows,
    standalone,
    totalTasks: list.filter((t) => t && typeof t === 'object').length,
    doneTasks,
  };
}
