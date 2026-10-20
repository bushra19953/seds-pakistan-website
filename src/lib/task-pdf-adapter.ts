/**
 * Task -> Workflow PDF adapter.
 *
 * Maps a standalone task doc into `WorkflowPDFData` so the existing
 * `exportWorkflowAsPDF()` in `workflow-pdf-export.ts` can render a
 * standalone task as a one-step workflow PDF.
 *
 * The mapping mirrors `handleExportPDF` in
 * `src/app/admin/workflows/page.tsx` exactly (complexity from
 * `workflowPriority`, domain from `workflowTags[0]`, `resourceLinks`
 * merged into resources, assigneeChapter fallback).
 */

import type { WorkflowPDFData, WorkflowPDFStep } from './workflow-pdf-export';

export interface TaskPDFAssignee {
  id: string;
  name?: string;
  email?: string;
  whatsapp?: string;
  chapterName?: string;
  role?: string | null;
  photoBase64?: string;
}

export interface TaskPDFInput {
  /** The raw task doc. */
  task: Record<string, any>;
  /** Primary assignee first, then co-assignees. */
  assignees: TaskPDFAssignee[];
  /** Resolved chapter name for the task's chapterId. */
  chapterName?: string;
}

const COMPLETED_STATUSES = new Set(['completed', 'approved']);

const isDone = (status: unknown): boolean =>
  COMPLETED_STATUSES.has(String(status || '').toLowerCase());

const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value === null || value === undefined ? undefined : value;

function complexityFromPriority(priority: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  if (!priority) return undefined;
  switch (String(priority).toLowerCase()) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    default:
      return 2;
  }
}

function mergeResources(task: Record<string, any>): Array<{ title: string; url: string; type: string }> | undefined {
  const base: Array<{ title: string; url: string; type: string }> = Array.isArray(task.resources)
    ? task.resources
        .map((r: any) => ({ title: orUndefined(r?.title), url: orUndefined(r?.url), type: orUndefined(r?.type) }))
        .filter((r: any) => r.url)
    : [];
  const extra: Array<{ title: string; url: string; type: string }> = String(task.resourceLinks || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((url) => ({ type: 'link', url, title: url }));
  const merged = [...base, ...extra];
  return merged.length > 0 ? merged : undefined;
}

export function taskToWorkflowPDFData(input: TaskPDFInput): WorkflowPDFData {
  const { task, assignees, chapterName } = input;
  const primary = assignees[0];
  const done = isDone(task.status);

  const step: WorkflowPDFStep = {
    id: orUndefined(task.id),
    title: String(task.title ?? 'Untitled task'),
    description: orUndefined(task.description),
    role: orUndefined(task.role),
    assigneeRole: orUndefined(primary?.role),
    assigneeName: orUndefined(primary?.name),
    assigneeEmail: orUndefined(primary?.email),
    assigneeWhatsapp: orUndefined(primary?.whatsapp),
    assigneeChapter: orUndefined(primary?.chapterName) || orUndefined(chapterName) || undefined,
    assigneePhoto: orUndefined(primary?.photoBase64),
    assignees: assignees.map((a) => ({
      id: a.id,
      name: a.name ?? 'Unnamed assignee',
      role: orUndefined(a.role),
      chapterName: orUndefined(a.chapterName),
    })),
    status: orUndefined(task.status),
    individualDeadline: orUndefined(task.individualDeadline) ?? orUndefined(task.deadline) ?? undefined,
    sequenceIndex: 0,
    assigneeId: orUndefined(task.assigneeId) ?? primary?.id,
    points: orUndefined(task.points),
    penaltyPoints: orUndefined(task.penaltyPoints),
    workflowBonusPoints: orUndefined(task.workflowBonusPoints),
    guidance: orUndefined(task.guidance),
    stepInstructions: orUndefined(task.stepInstructions),
    complexity: complexityFromPriority(task.workflowPriority),
    domain:
      Array.isArray(task.workflowTags) && task.workflowTags.length > 0
        ? orUndefined(task.workflowTags[0])
        : undefined,
    resources: mergeResources(task),
  };

  return {
    id: String(task.id),
    title: String(task.title ?? 'Untitled task'),
    progressPercentage: done ? 100 : 0,
    totalSteps: 1,
    completedSteps: done ? 1 : 0,
    isCompleted: done,
    chapterName: orUndefined(chapterName),
    createdAt: orUndefined(task.createdAt),
    description: orUndefined(task.description),
    participants: assignees
      .map((a) => a.name)
      .filter((n): n is string => Boolean(n)),
    steps: [step],
  };
}
