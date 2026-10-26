'use client';

import { useEffect, useState } from 'react';
import { useUserContext } from '@/firebase/user-provider';
import { formatApprovalRateLabel, type ApprovalRate } from '@/lib/server/task-approval-rate';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  /**
   * Request revisions. Deadline fairness (founder rule, 2026-10-26):
   * a return from review must carry the reviewer's feedback AND a new
   * deadline the reviewer consciously sets; the field starts empty on
   * purpose, and the tasks API refuses the return without both.
   */
  onRequestRevisions: (taskId: string, feedbackText: string, reviewDeadlineIso: string) => void | Promise<void>;
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
  const [revisionFeedback, setRevisionFeedback] = useState('');
  const [revisionDeadline, setRevisionDeadline] = useState('');
  const { user } = useUserContext();
  const open = task !== null;

  // The revision fields belong to one task only: never carry a
  // deadline typed for one submission over to the next.
  useEffect(() => {
    setRevisionFeedback('');
    setRevisionDeadline('');
  }, [task?.id]);

  const t = (task || {}) as any;

  // Submission author: resolve name via usersMap, fall back to the raw id.
  const submittedById = t.submittedBy || t.submittedById;

  // Grove Item 13: the submitter's last-10 approval rate, fetched from
  // the read-only approval-rate route when the drawer opens and shown
  // beside the Approve action in the footer. Garnish only: a failed
  // fetch hides the line and never blocks the review.
  const rateSubjectUid: string | undefined =
    submittedById ||
    (typeof t.assigneeId === 'string' ? t.assigneeId : undefined) ||
    (Array.isArray(t.assigneeIds) ? t.assigneeIds[0] : undefined) ||
    (Array.isArray(t.assigneeId) ? t.assigneeId[0] : undefined);
  const [approvalRate, setApprovalRate] = useState<ApprovalRate | null>(null);
  const [rateLoading, setRateLoading] = useState(false);

  useEffect(() => {
    if (!open || !rateSubjectUid || !user) {
      setApprovalRate(null);
      return;
    }
    let cancelled = false;
    setRateLoading(true);
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch(`/api/tasks/approval-rate?uid=${encodeURIComponent(rateSubjectUid)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('approval-rate fetch failed');
        const json = await res.json();
        if (!cancelled) {
          setApprovalRate({
            approved: typeof json.approved === 'number' ? json.approved : 0,
            decided: typeof json.decided === 'number' ? json.decided : 0,
            rate: typeof json.rate === 'number' ? json.rate : null,
            hasHistory: json.hasHistory === true,
          });
        }
      } catch {
        if (!cancelled) setApprovalRate(null);
      } finally {
        if (!cancelled) setRateLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id, rateSubjectUid, user?.uid]);
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

  // Deadline fairness (founder rule, 2026-10-26): a return from
  // review needs the reviewer's feedback AND a new deadline the
  // reviewer sets. Without both, the request cannot fire here, and
  // the tasks API refuses it as well.
  const handleRevisions = async () => {
    if (!task || revising) return;
    if (!revisionFeedback.trim() || !revisionDeadline) return;
    if (typeof window !== 'undefined' && !window.confirm('Send this task back for revisions with the new deadline you set?')) return;
    setRevising(true);
    try {
      await onRequestRevisions(task.id, revisionFeedback.trim(), new Date(revisionDeadline).toISOString());
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
            <div className="space-y-3 mb-4">
              <div className="space-y-1.5">
                <Label htmlFor="revision-feedback" className="text-xs">Feedback for revisions (required to request revisions)</Label>
                <Textarea
                  id="revision-feedback"
                  rows={2}
                  value={revisionFeedback}
                  onChange={(e) => setRevisionFeedback(e.target.value)}
                  placeholder="What must change before this can be approved?"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="revision-deadline" className="text-xs">New deadline (required to request revisions)</Label>
                <Input
                  id="revision-deadline"
                  type="datetime-local"
                  value={revisionDeadline}
                  onChange={(e) => setRevisionDeadline(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">
                  The task returns to the assignee with this deadline. It starts empty on purpose: pick the date yourself.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Item 13: the submitter's record at the inspection point,
                  left-aligned beside the decision buttons. Labelled as
                  submission history, never as a verdict on the person. */}
              <div className="mr-auto min-w-0 pr-2">
                {rateLoading ? (
                  <p className="text-[11px] text-muted-foreground">Checking submission history...</p>
                ) : approvalRate ? (
                  <p className="text-[11px] text-muted-foreground">
                    <span className="font-semibold text-foreground">Submission history:</span>{' '}
                    {formatApprovalRateLabel(approvalRate)}
                  </p>
                ) : null}
              </div>
              <Button variant="outline" size="sm" disabled={approving || revising || !revisionFeedback.trim() || !revisionDeadline} onClick={handleRevisions}>
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
