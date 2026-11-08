'use client';

/**
 * One row of the admin tasks table, extracted from page.tsx and wrapped
 * in React.memo (vercel-react-best-practices: rerender-memo).
 *
 * The row used to be rendered inline by the page component, so ANY page
 * state change (toggling one row's checkbox, an export starting, a
 * dialog opening) re-rendered all ~100 rows, each carrying a Radix
 * tooltip subtree and several date derivations. The page now passes
 * only primitives and stable callbacks, so a row re-renders only when
 * its own task, its assignee/project display data, its selected flag,
 * or its exporting flag actually changes.
 *
 * The single TooltipProvider lives in the page around the table; this
 * component renders Tooltip parts only.
 */
import { memo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { format } from 'date-fns';
import { TableCell, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toDate } from '@/lib/date-utils';
import type { Task } from '@/lib/task-types';

export interface TaskTableRowProps {
  task: Task;
  assigneeUser: any;
  assigneeRoleName: string;
  projectTitle: string;
  usersMap: Record<string, any>;
  selected: boolean;
  exporting: boolean;
  onToggleSelect: (taskId: string, checked: boolean) => void;
  onEdit: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onExport: (task: Task) => void;
  onApprove: (taskId: string) => void;
  onViewSubmission: (task: Task) => void;
  onRequestRevisions: (task: Task) => void;
}

function TaskTableRowInner({
  task,
  assigneeUser,
  assigneeRoleName,
  projectTitle,
  usersMap,
  selected,
  exporting,
  onToggleSelect,
  onEdit,
  onDelete,
  onExport,
  onApprove,
  onViewSubmission,
  onRequestRevisions,
}: TaskTableRowProps) {
  const reduceMotion = useReducedMotion();
  const assigneeName = assigneeUser?.displayName || assigneeUser?.email || task.assigneeId;
  const coAssigneeIds = (Array.isArray((task as any).assigneeIds) ? (task as any).assigneeIds : [])
    .map(String).filter((id: string) => id && id !== task.assigneeId);

  return (
      <TableRow data-state={selected && "selected"}>
        <TableCell>
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onToggleSelect(task.id, !!checked)}
            aria-label="Select row"
          />
        </TableCell>
        <TableCell className="font-medium max-w-xs truncate">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate">{task.title}</span>
            {task.status === 'submitted-for-review' && (
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-violet-200 bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300">
                <motion.span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
                  animate={reduceMotion ? undefined : { opacity: [1, 0.3, 1] }}
                  transition={reduceMotion ? undefined : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                />
                Submitted for Review
              </span>
            )}
          </div>
        </TableCell>
        <TableCell>
          <div>
            <div>{assigneeName}{coAssigneeIds.length > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">+{coAssigneeIds.length}</span>
            )}</div>
            <div className="text-xs text-muted-foreground">{assigneeRoleName}</div>
          </div>
        </TableCell>
        <TableCell>
          {task.workflowId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex -space-x-2 cursor-help">
                    {(task.workflowParticipantIds || []).slice(0, 3).map((uid, i) => (
                      <Avatar key={`${task.id}-p-${i}`} className="h-6 w-6 border-2 border-background">
                        <AvatarImage src={usersMap[uid]?.photoURL} />
                        <AvatarFallback className="text-[10px]">
                          {(usersMap[uid]?.displayName || usersMap[uid]?.email || uid).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                    {(task.workflowParticipantIds || []).length > 3 && (
                      <div className="h-6 w-6 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[10px]">
                        +{(task.workflowParticipantIds || []).length - 3}
                      </div>
                    )}
                    {(task.workflowParticipantIds || []).length === 0 && (
                      <Badge variant="outline" className="text-[10px] h-5">No participants</Badge>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1">
                    <p className="font-semibold text-xs text-primary mb-1">Workflow Team:</p>
                    {(task.workflowParticipantIds || []).map(uid => (
                      <p key={uid} className="text-[10px]">
                        {usersMap[uid]?.displayName || usersMap[uid]?.email || uid}
                      </p>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          {projectTitle}
        </TableCell>
        <TableCell>
          {(() => {
            // Phase 6 Fix: Use robust date normalizer
            const d = toDate(task.individualDeadline) || toDate(task.deadline);
            const now = new Date();
            const isOverdue = d && d < now;
            // Status pill system (21st.dev "Status Badge" pattern): one pill
            // shape, a tone per status, and a leading dot in the tone colour.
            // The hue-to-status mapping is unchanged from the original
            // classes; dark mode swaps the pastel fill for a translucent
            // tint so the pill reads on the dark admin theme.
            const klass = task.status === 'completed'
              ? 'border-green-200 bg-green-100 text-green-800 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300'
              : task.status === 'in-progress'
                ? 'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300'
                : (isOverdue && task.status !== 'submitted-for-review')
                  ? 'border-red-200 bg-red-100 text-red-800 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300'
                  : 'border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-500/30 dark:bg-yellow-500/15 dark:text-yellow-300';
            const dotKlass = task.status === 'completed'
              ? 'bg-green-500'
              : task.status === 'in-progress'
                ? 'bg-blue-500'
                : (isOverdue && task.status !== 'submitted-for-review')
                  ? 'bg-red-500'
                  : 'bg-yellow-500';

            // Display status label
            let label = task.status;
            if (isOverdue && task.status !== 'completed' && task.status !== 'submitted-for-review') label = 'overdue';

            return (
              <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${klass}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotKlass}`} />
                {label}
              </span>
            );
          })()}
        </TableCell>
        <TableCell>
          {(() => {
            const n = Array.isArray((task as any).deliverableFiles)
              ? (task as any).deliverableFiles.length
              : 0;
            return n > 0 ? (
              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-sky-200 bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300">
                {n} file{n === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            );
          })()}
        </TableCell>
        <TableCell>
          {(() => {
            const d = toDate(task.individualDeadline) || toDate(task.deadline);
            return d ? format(d, 'dd/MM/yyyy hh:mm a') : '—';
          })()}
        </TableCell>
        <TableCell>{task.points}</TableCell>
        <TableCell>
          {(() => {
            const assigned = (assigneeUser as any)?.tasksAssignedCount ?? 0;
            const completed = (assigneeUser as any)?.tasksCompletedCount ?? 0;
            const onTime = (assigneeUser as any)?.tasksCompletedOnTimeCount ?? 0;
            const efficiency = assigned > 0 ? `${completed}/${assigned}` : '—';
            // Cap at 100% — data inconsistency (onTime > completed) should not display impossible values
            const onTimePct = completed > 0 ? Math.min(100, Math.round((onTime / completed) * 100)) : 0;
            return assigned > 0 ? `${efficiency} • ${onTimePct}% on-time` : '—';
          })()}
        </TableCell>
        <TableCell>
          {(() => {
            const c = toDate(task.createdAt);
            return c ? format(c, 'dd/MM/yyyy hh:mm a') : '—';
          })()}
        </TableCell>
        <TableCell>
          <div className="flex space-x-2">
            <Button variant="outline" size="sm" onClick={() => onEdit(task.id)}>
              Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onDelete(task.id)}>
              Delete
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting}
              onClick={() => onExport(task)}
            >
              {exporting ? 'Exporting...' : 'Export PDF'}
            </Button>
            {!['completed', 'approved', 'submitted-for-review'].includes(task.status) && (
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-foreground"
                onClick={() => {
                  if (!confirm('Mark this task as completed? Points and any badge will be awarded as usual.')) return;
                  onApprove(task.id);
                }}
              >
                Mark Completed
              </Button>
            )}
            {task.status === 'submitted-for-review' && (
              <>
                <Button variant="outline" size="sm" onClick={() => onViewSubmission(task)}>
                  View Submission
                </Button>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-foreground" onClick={() => onApprove(task.id)}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => onRequestRevisions(task)}>
                  Request Revisions
                </Button>
              </>
            )}
          </div>
        </TableCell>
      </TableRow>
  );
}

const TaskTableRow = memo(TaskTableRowInner);
export default TaskTableRow;
