"use client";

import { useEffect, useState, type ReactNode } from 'react';
import { useUser } from '@/firebase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import {
  ShieldCheck,
  Loader2,
  Clock,
  Coins,
  FileImage,
  FileArchive,
  FileText,
  File as FileIcon,
  Link2,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { chunkDescription } from '@/lib/description-chunks';

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

/** Whole-row tappable attachment link used for proof files and resource URLs. */
const ATTACHMENT_ROW_CLASS =
  'flex min-h-[44px] items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2 transition-colors hover:bg-accent';

function formatFileSize(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function proofFileIcon(file: { fileName?: string; contentType?: string }): LucideIcon {
  const type = (file.contentType || '').toLowerCase();
  const name = (file.fileName || '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) return FileImage;
  if (type.includes('zip') || /\.(zip|rar|7z|tar|gz)$/.test(name)) return FileArchive;
  if (type.includes('pdf') || /\.(pdf|docx?|txt|md)$/.test(name)) return FileText;
  return FileIcon;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
      {children}
    </h4>
  );
}

/**
 * Awaiting Your Validation: tasks submitted by people below the viewer in
 * the reporting chain (or assigned by the viewer) that are waiting for a
 * validation decision. Rendered only when non-empty, on the viewer's own
 * profile, pinned above Mission Control.
 */
export function ValidationQueue({ onReview }: { onReview?: (taskId: string) => void }) {
  const { user } = useUser();
  const { showSuccessToast, showErrorToast } = useEnhancedToast();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [mode, setMode] = useState<'review' | 'reject'>('review');
  const [feedback, setFeedback] = useState('');
  const [newDeadline, setNewDeadline] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeAction, setActiveAction] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/tasks/review-queue', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setItems(Array.isArray(data.tasks) ? data.tasks : []);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.uid]);

  if (!items || items.length === 0) return null;

  const chainLabel = (item: QueueItem) => {
    if (item.via === 'assigner') return 'Assigner';
    if (item.via === 'reviewer') return 'Named reviewer';
    if (item.via === 'chain' && item.depth != null) {
      return `${item.depth} ${item.depth === 1 ? 'level' : 'levels'} above submitter`;
    }
    return 'Task manager';
  };

  const formatDate = (iso?: string) => {
    if (!iso) return 'No deadline';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? 'No deadline' : d.toLocaleString();
  };

  const closeDialog = () => {
    setSelected(null);
    setMode('review');
    setFeedback('');
    setNewDeadline('');
    setActiveAction(null);
  };

  const openReview = (item: QueueItem) => {
    setSelected(item);
    setMode('review');
    setFeedback('');
    setNewDeadline('');
  };

  const removeItem = (id: string) =>
    setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));

  const handleApprove = async () => {
    if (!user || !selected || submitting) return;
    const item = selected;
    setSubmitting(true);
    setActiveAction('approve');
    try {
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.id, updates: { status: 'completed' } }),
      });
      if (res.status === 409) {
        showErrorToast('A decision was already recorded for this task. Refresh to see it.');
        removeItem(item.id);
        closeDialog();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showErrorToast(data.error || 'Approval failed');
        return;
      }
      showSuccessToast('Mission Accomplished & Points Awarded');
      removeItem(item.id);
      closeDialog();
    } catch {
      showErrorToast('Approval failed');
    } finally {
      setSubmitting(false);
      setActiveAction(null);
    }
  };

  const canConfirmReject =
    feedback.trim().length > 0 &&
    newDeadline.length > 0 &&
    new Date(newDeadline).getTime() > Date.now();

  const handleConfirmReject = async () => {
    if (!user || !selected || submitting || !canConfirmReject) return;
    const item = selected;
    setSubmitting(true);
    setActiveAction('reject');
    try {
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: item.id,
          updates: {
            status: 'changes-requested',
            feedback_text: feedback.trim(),
            reviewDeadline: new Date(newDeadline).toISOString(),
          },
        }),
      });
      if (!res.ok) throw new Error('Revision request failed');
      showSuccessToast('Revision Instructions Transmitted');
      removeItem(item.id);
      closeDialog();
    } catch {
      showErrorToast('Failed to request revision');
    } finally {
      setSubmitting(false);
      setActiveAction(null);
    }
  };

  const resourceUrls = selected?.resourceLinks
    ? (selected.resourceLinks.match(/https?:\/\/[^\s,]+/g) ?? [])
    : [];
  // Render the description in the platform's chunked labeled format when it
  // carries template labels (the same chunkDescription the mission PDF uses);
  // otherwise fall back to clean paragraphs split on blank lines.
  const descriptionChunks = selected?.description ? chunkDescription(selected.description) : [];
  const descriptionHasLabels = descriptionChunks.some((chunk) => chunk.label);
  const descriptionParagraphs =
    selected?.description && !descriptionHasLabels
      ? selected.description
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
  const hasProof =
    !!selected &&
    ((selected.deliverableFiles?.length ?? 0) > 0 ||
      (selected.resourceLinks?.trim().length ?? 0) > 0 ||
      typeof selected.hoursWorked === 'number');

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-primary">
          <ShieldCheck className="h-5 w-5" />
          Awaiting Your Validation
          <span className="ml-auto text-xs font-mono bg-primary text-black rounded-full px-2 py-0.5">
            {items.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="p-4 rounded-xl border border-border bg-card/60 flex flex-col gap-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  Submitted by {item.submitterName}
                  {item.submitterRole ? ` (${item.submitterRole.replace(/_/g, ' ')})` : ''}
                </p>
                <p className="text-[11px] text-primary font-medium">
                  Your role: {chainLabel(item)}
                </p>
              </div>
              {typeof item.points === 'number' && (
                <span className="shrink-0 inline-flex items-center gap-1 text-xs font-bold text-amber-400">
                  <Coins className="h-3.5 w-3.5" /> {item.points}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
              {item.submittedAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Submitted {new Date(item.submittedAt).toLocaleDateString()}
                </span>
              )}
              <span>Deadline: {formatDate(item.deadline)}</span>
            </div>
            <div>
              <Button
                size="sm"
                className="min-h-[44px]"
                onClick={() => {
                  if (onReview) onReview(item.id);
                  else openReview(item);
                }}
              >
                Review Submission
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !submitting) closeDialog();
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[90vh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
          {selected && (
            <div className="min-w-0 space-y-4">
              <DialogHeader>
                <DialogTitle className="text-lg leading-snug [overflow-wrap:anywhere]">
                  {selected.title}
                </DialogTitle>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  Submitted by {selected.submitterName}
                  {selected.submitterRole ? ` (${selected.submitterRole.replace(/_/g, ' ')})` : ''}
                </p>
                <p className="text-[11px] text-primary font-medium">
                  Your role: {chainLabel(selected)}
                </p>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {selected.submittedAt && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Submitted {new Date(selected.submittedAt).toLocaleDateString()}
                  </span>
                )}
                <span>Deadline: {formatDate(selected.deadline)}</span>
                {typeof selected.points === 'number' && (
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-400">
                    <Coins className="h-3.5 w-3.5" /> {selected.points}
                  </span>
                )}
              </div>

              {selected.workflowId && (
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {selected.workflowTitle
                    ? selected.workflowTitle
                    : typeof selected.sequenceIndex === 'number'
                      ? `Workflow step ${selected.sequenceIndex + 1}`
                      : 'Workflow step'}
                </p>
              )}

              {selected.description && (
                <section className="space-y-2">
                  <SectionHeading>Description</SectionHeading>
                  {descriptionHasLabels ? (
                    <div className="space-y-2.5">
                      {descriptionChunks.map((chunk, i) => (
                        <div key={i} className="min-w-0">
                          {chunk.label && (
                            <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wider text-primary">
                              {chunk.label}
                            </span>
                          )}
                          <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">
                            {chunk.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {descriptionParagraphs.map((para, i) => (
                        <p
                          key={i}
                          className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]"
                        >
                          {para}
                        </p>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="space-y-2">
                <SectionHeading>Submission report</SectionHeading>
                {selected.report ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
                    {selected.report}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No report text on this submission.</p>
                )}
              </section>

              {hasProof && (
                <section className="space-y-2">
                  <SectionHeading>Proof</SectionHeading>
                  <div className="space-y-2">
                    {selected.deliverableFiles?.map((file, i) => {
                      const Icon = proofFileIcon(file);
                      const name = file.fileName || 'Proof file';
                      const size = formatFileSize(file.sizeBytes);
                      return (
                        <a
                          key={`${file.downloadUrl}-${i}`}
                          href={file.downloadUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={ATTACHMENT_ROW_CLASS}
                        >
                          <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm" title={name}>
                            {name}
                          </span>
                          {size && (
                            <span className="shrink-0 text-xs text-muted-foreground">{size}</span>
                          )}
                          <ExternalLink
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        </a>
                      );
                    })}
                    {resourceUrls.length > 0
                      ? resourceUrls.map((url, i) => (
                          <a
                            key={`${url}-${i}`}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className={ATTACHMENT_ROW_CLASS}
                          >
                            <Link2 className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-sm" title={url}>
                              {url}
                            </span>
                            <ExternalLink
                              className="h-4 w-4 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          </a>
                        ))
                      : selected.resourceLinks?.trim() && (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
                            {selected.resourceLinks}
                          </p>
                        )}
                    {typeof selected.hoursWorked === 'number' && (
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        Hours worked: {selected.hoursWorked}
                      </p>
                    )}
                  </div>
                </section>
              )}

              {mode === 'review' ? (
                <div className="flex flex-wrap gap-2">
                  <Button className="min-h-[44px] flex-1" disabled={submitting} onClick={handleApprove}>
                    {activeAction === 'approve' && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    className="min-h-[44px] flex-1"
                    disabled={submitting}
                    onClick={() => setMode('reject')}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label htmlFor="review-rejection-reason" className="text-sm font-medium">
                      Reason for rejection (required)
                    </label>
                    <Textarea
                      id="review-rejection-reason"
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      disabled={submitting}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="review-new-deadline" className="text-sm font-medium">
                      New deadline (required)
                    </label>
                    <Input
                      id="review-new-deadline"
                      type="datetime-local"
                      value={newDeadline}
                      onChange={(e) => setNewDeadline(e.target.value)}
                      disabled={submitting}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      The task returns to the assignee with this deadline. Pick the date yourself; there is no default.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="min-h-[44px] flex-1"
                      disabled={submitting}
                      onClick={() => setMode('review')}
                    >
                      Back
                    </Button>
                    <Button
                      className="min-h-[44px] flex-1"
                      disabled={submitting || !canConfirmReject}
                      onClick={handleConfirmReject}
                    >
                      {activeAction === 'reject' && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Confirm Rejection
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function ValidationQueueLoader() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
      <Loader2 className="h-4 w-4 animate-spin" /> Checking for submissions awaiting your validation...
    </div>
  );
}
