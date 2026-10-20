'use client';

import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { ProofPreview } from '@/components/profile/proof-submission-drawer';
import { Loader2, Undo2, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';

/**
 * SubmissionApprovalDrawer: the admin review drawer for submitted-for-review
 * tasks on /admin/tasks. A slide-in drawer (not a modal) with inline media
 * previews of the assignee's deliverable files, one-click approve (no confirm
 * dialog), and a revision path that still asks for confirmation.
 *
 * Read-only otherwise: it never edits the task, it only fires the approve
 * or request-revisions actions the parent passes in.
 *
 * No em dashes anywhere in this file; user-facing text follows the house rule.
 */

export interface SubmissionApprovalDrawerProps {
  task: any | null;
  /** uid -> { displayName, email, photoURL } for resolving the submitter. */
  usersMap?: Record<string, { displayName?: string; email?: string; photoURL?: string }>;
  onClose: () => void;
  onApprove: (taskId: string) => void | Promise<void>;
  onRequestRevisions: (taskId: string) => void | Promise<void>;
}

function toDate(v: any): Date | null {
  if (!v) return null;
  try {
    const d = typeof v?.toDate === 'function' ? v.toDate() : new Date(v);
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

export default function SubmissionApprovalDrawer({
  task,
  usersMap = {},
  onClose,
  onApprove,
  onRequestRevisions,
}: SubmissionApprovalDrawerProps) {
  const [approving, setApproving] = useState(false);
  const [revising, setRevising] = useState(false);
  const open = task !== null;

  const t = (task || {}) as any;

  // Submission author: resolve name via usersMap, fall back to the raw id.
  const submittedById = t.submittedBy || t.submittedById;
  const submittedByUser = submittedById ? usersMap[submittedById] : undefined;
  const submittedByLabel =
    submittedByUser?.displayName || submittedByUser?.email || submittedById || 'No submitter recorded';

  // Prefer submittedAt; updatedAt is shown only when no submission timestamp
  // exists, and labeled as such.
  const submittedAt = toDate(t.submittedAt);
  const fallbackAt = toDate(t.updatedAt);
  const timestampLabel = submittedAt ? 'Submitted at' : 'Updated at (no submission timestamp recorded)';
  const timestamp = submittedAt || fallbackAt;

  const hours = typeof t.hoursWorked === 'number' ? t.hoursWorked : null;

  // Deliverable files: plain array of
  // { fileName, driveFileId, downloadUrl, sizeBytes, contentType }. Guard
  // for non-array values and entries without a usable URL.
  const rawFiles = t.deliverableFiles;
  const files: Array<{ fileName?: string; driveFileId?: string; downloadUrl: string; contentType?: string; sizeBytes?: number }> =
    Array.isArray(rawFiles)
      ? rawFiles.filter((f: any) => f && typeof f.downloadUrl === 'string' && f.downloadUrl.length > 0)
      : [];

  // resourceLinks may be stored as a newline-separated string or an array.
  const rawLinks = t.resourceLinks;
  const links: string[] = (Array.isArray(rawLinks)
    ? rawLinks
    : typeof rawLinks === 'string'
      ? rawLinks.split('\n')
      : []
  )
    .map((l: string) => String(l).trim())
    .filter((l: string) => l.length > 0);

  const handleApprove = async () => {
    if (!task || approving) return;
    setApproving(true);
    try {
      await onApprove(task.id);
      onClose();
    } finally {
      setApproving(false);
    }
  };

  const handleRevisions = async () => {
    if (!task || revising) return;
    if (typeof window !== 'undefined' && !window.confirm('Send this task back for revisions?')) return;
    setRevising(true);
    try {
      await onRequestRevisions(task.id);
      onClose();
    } finally {
      setRevising(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col gap-0 p-0"
        aria-label={`Review submission: ${t.title || 'task'}`}
      >
        <SheetHeader className="px-5 pt-5 pb-4 border-b border-border/60 text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status="submitted-for-review" size="xs" />
            {hours !== null && (
              <Badge variant="secondary" className="text-xs px-2.5 py-0.5">{hours}h logged</Badge>
            )}
          </div>
          <SheetTitle className="text-lg font-black tracking-tight break-words pr-8 mt-2">
            {t.title || 'Submission'}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Review what the assignee submitted, then approve it or send it back.
          </SheetDescription>
        </SheetHeader>

        {task && (
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Submitted by</p>
                <p className="text-sm font-medium break-all">{submittedByLabel}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">{timestampLabel}</p>
                <p className="text-sm">{timestamp ? format(timestamp, 'dd/MM/yyyy hh:mm a') : 'Not recorded'}</p>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Report</p>
              {t.report ? (
                <div className="text-sm whitespace-pre-wrap rounded-md border bg-muted/40 p-3">{t.report}</div>
              ) : (
                <p className="text-sm text-muted-foreground">No report submitted</p>
              )}
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                Deliverable files ({files.length})
              </p>
              {files.length > 0 ? (
                <ul className="space-y-2">
                  {files.map((file, i) => (
                    <li
                      key={file.driveFileId || `file-${i}`}
                      className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2"
                    >
                      <ProofPreview file={file} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-foreground truncate">
                          {file.fileName || 'Deliverable file'}
                        </p>
                        <p className="text-[10px] text-muted-foreground">inline preview available</p>
                      </div>
                      <a
                        href={file.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] font-bold text-primary underline underline-offset-2 shrink-0"
                      >
                        Open
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No deliverable files submitted</p>
              )}
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Deliverable links</p>
              {links.length > 0 ? (
                <div className="space-y-2">
                  {links.map((link: string, i: number) => (
                    <a
                      key={i}
                      href={link.startsWith('http') ? link : `https://${link}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-sm text-primary underline underline-offset-2 break-all rounded-md border p-2.5 hover:bg-muted/40"
                    >
                      {link}
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No deliverable links submitted</p>
              )}
            </div>
          </div>
        )}

        {task && (
          <div className="border-t border-border/60 px-5 py-4 bg-card/40">
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={approving || revising} onClick={handleRevisions}>
                {revising ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Undo2 className="h-4 w-4 mr-1.5" />}
                Request revisions
              </Button>
              {/* One-click approve: no confirm dialog. Approve and close. */}
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={approving || revising}
                onClick={handleApprove}
              >
                {approving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
                Approve
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 text-right">
              Approving awards the task points and any badge, as usual.
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
