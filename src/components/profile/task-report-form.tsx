'use client';

import { useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';
import { RefreshCw, ChevronDown, ExternalLink, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SubmitButton } from '@/components/ui/submit-button';
import { SubmissionChecklist } from './submission-checklist';
import DeliverableUploader from './deliverable-uploader';
import { useUnsavedUploadsWarning } from './use-unsaved-uploads-warning';
import { syncedFieldValue } from '@/lib/form-sync';
import type { DriveUploadMeta } from '@/lib/uploads/client';

/**
 * The assignee's report form for one task card on the Mission Control
 * board (extracted from TaskCardImpl in assigned-tasks.tsx).
 *
 * It owns the typing state (report, hours, session uploads) so a
 * keystroke re-renders ONLY this form — never the team strip, the
 * briefing, the workflow steps, or the workflow chat that share the
 * expanded card. Fresh task data re-seeds a field only while the
 * user has not diverged from the last synced value (dirty-wins,
 * src/lib/form-sync.ts): a board refetch or a live update can no
 * longer replace a report mid-typing.
 *
 * Typing-lag fix, 2026-10-26:
 * ~/workspace/known_issues/typing_lag_ahmed_2026-10-26.md
 */

const safeDate = (d: any) => {
  if (!d) return null;
  try {
    if (d?.toDate && typeof d.toDate === 'function') return d.toDate();
    if (d && typeof d === 'object') {
      if (typeof d.seconds === 'number') return new Date(d.seconds * 1000);
      if (typeof d._seconds === 'number') return new Date(d._seconds * 1000); // Admin SDK serialized Timestamp
    }
    const date = new Date(d);
    return isNaN(date.getTime()) ? null : date;
  } catch { return null; }
};

// One row of the submission progress indicator: what is done, what is left.
function SubmissionStepRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {done
        ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" aria-label="Done" />
        : <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/40 shrink-0" aria-hidden="true" />}
      <span className={`text-xs font-semibold ${done ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
    </div>
  );
}

interface TaskReportFormProps {
  task: any;
  canEdit: boolean;
  onTaskUpdated: () => void;
  /** Bring this card into its expanded state (validation focus path). */
  onExpand: () => void;
  /**
   * Live mirror of the report text, written on every change. The
   * parent card's check-in action reads the current text from here;
   * a ref (not state) keeps typing from re-rendering the card.
   */
  reportValueRef: { current: string };
}

export function TaskReportForm({ task, canEdit, onTaskUpdated, onExpand, reportValueRef }: TaskReportFormProps) {
  const [inlineReport, setInlineReportState] = useState(task.report || '');
  const hoursValueRef = useRef(typeof task.hoursWorked === 'number' ? String(task.hoursWorked) : '0.0');
  const [inlineHours, setInlineHoursState] = useState(hoursValueRef.current);
  const setInlineReport = (value: string) => { reportValueRef.current = value; setInlineReportState(value); };
  const setInlineHours = (value: string) => { hoursValueRef.current = value; setInlineHoursState(value); };
  const [isUpdating, setIsUpdating] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  // Ref to the report field so validation can focus it when the user
  // tries to submit for review without writing a report.
  const reportRef = useRef<HTMLTextAreaElement>(null);
  // Pre-submit validation: the server rejects any submit-for-review with an
  // empty report (PATCH /api/tasks returns 400), so mirror that requirement
  // here with an inline message naming the missing field before the PATCH fires.
  const [reportError, setReportError] = useState<string | null>(null);
  // Step 2 of the two-step submit: true while the pre-submit summary screen
  // is open for the user to confirm exactly what gets sent.
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  // Proof files uploaded in this session. Merged with the task's existing
  // deliverableFiles on save/submit; the server replaces the array wholesale.
  const [uploadedFiles, setUploadedFiles] = useState<DriveUploadMeta[]>([]);
  const [filesUploading, setFilesUploading] = useState(false);

  // Warn before leaving the page while uploaded files have not been submitted
  // yet — uploading alone does NOT attach the file to the task.
  useUnsavedUploadsWarning(uploadedFiles.length > 0);

  // Dirty-wins sync (see src/lib/form-sync.ts). A different task resets
  // the form outright; the same task may only re-seed fields the user
  // has not diverged from the last synced values.
  const lastSyncedRef = useRef<{ id: string | null; report: string; hours: string }>({ id: null, report: '', hours: '0.0' });
  useEffect(() => {
    const savedReport = task.report || '';
    const savedHours = typeof task.hoursWorked === 'number' ? String(task.hoursWorked) : '0.0';
    const last = lastSyncedRef.current;
    if (last.id !== task.id) {
      lastSyncedRef.current = { id: task.id, report: savedReport, hours: savedHours };
      setInlineReport(savedReport);
      setInlineHours(savedHours);
      setReportError(null);
      setUploadedFiles([]);
      return;
    }
    const nextReport = syncedFieldValue(reportValueRef.current, last.report, savedReport);
    if (nextReport !== reportValueRef.current) setInlineReport(nextReport);
    const nextHours = syncedFieldValue(hoursValueRef.current, last.hours, savedHours);
    if (nextHours !== hoursValueRef.current) setInlineHours(nextHours);
    lastSyncedRef.current = { id: task.id, report: savedReport, hours: savedHours };
  }, [task]);

  // Two explicit actions, no status hunting. "Submit for review" validates the
  // report and opens the pre-submit summary. "Save draft" just saves the work
  // in progress — it never submits and never changes the task status.
  const handleSubmitClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filesUploading) {
      toast.error('Wait for your files to finish uploading, then submit again.');
      return;
    }
    if (!inlineReport.trim()) {
      setReportError('Write a progress report before submitting for review.');
      onExpand();
      setTimeout(() => reportRef.current?.focus(), 200);
      return;
    }
    setConfirmingSubmit(true);
  };

  const handleDraftSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleFullUpdate(e, 'draft');
  };

  const handleRecall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setIsUpdating(true);
      const { getAuth } = await import('firebase/auth');
      const token = await getAuth().currentUser?.getIdToken();
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          updates: { status: 'in-progress' }
        })
      });
      if (!res.ok) throw new Error();
      setIsSuccess(true);
      toast.success("Submission withdrawn. You can keep editing your task.");
      setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
    } catch (err) { toast.error("Withdraw failed. Please try again."); setIsUpdating(false); }
  };

  // Merge the session's new uploads with files already on the task. The
  // PATCH handler replaces deliverableFiles wholesale, so sending only the
  // new ones would wipe what was attached before. Deduped by driveFileId.
  const buildDeliverableFiles = () => {
    const seen = new Set<string>();
    const merged: Array<{ fileName?: string; driveFileId?: string; downloadUrl: string; sizeBytes?: number; contentType?: string }> = [];
    const push = (f: any) => {
      if (!f || typeof f.downloadUrl !== 'string' || f.downloadUrl.length === 0) return;
      const key = typeof f.driveFileId === 'string' && f.driveFileId ? f.driveFileId : `url:${f.downloadUrl}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({
        fileName: typeof f.fileName === 'string' ? f.fileName : undefined,
        driveFileId: typeof f.driveFileId === 'string' ? f.driveFileId : undefined,
        downloadUrl: f.downloadUrl,
        sizeBytes: typeof f.sizeBytes === 'number' ? f.sizeBytes : undefined,
        contentType: typeof f.contentType === 'string' ? f.contentType : undefined,
      });
    };
    (Array.isArray(task.deliverableFiles) ? task.deliverableFiles : []).forEach(push);
    uploadedFiles.forEach(push);
    return merged;
  };

  const handleFullUpdate = async (e: React.MouseEvent, mode: 'draft' | 'submit') => {
    e.stopPropagation();
    // Never fire the PATCH while an upload is mid-flight; the files would be
    // left out of the submission with no warning.
    if (filesUploading) {
      toast.error('Wait for your files to finish uploading, then submit again.');
      return;
    }
    // A review submission requires a real report. Draft saves may keep an
    // empty report as work in progress.
    if (mode === 'submit' && !inlineReport.trim()) {
      setReportError('Write a progress report before submitting for review.');
      onExpand();
      setTimeout(() => reportRef.current?.focus(), 200);
      return;
    }
    try {
      setIsUpdating(true);
      const { getAuth } = await import('firebase/auth');
      const token = await getAuth().currentUser?.getIdToken();
      const parsedHours = parseFloat(inlineHours);
      const updates: Record<string, any> = { report: inlineReport, hoursWorked: Number.isNaN(parsedHours) ? undefined : parsedHours };
      // Submitting sends the task to the reviewer. A draft save leaves the
      // task status exactly as it is — no status field is sent, so nothing
      // can silently flip between draft and submission.
      if (mode === 'submit') updates.status = 'submitted-for-review';
      if (uploadedFiles.length > 0) updates.deliverableFiles = buildDeliverableFiles();
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, updates })
      });
      if (!res.ok) throw new Error();
      setIsSuccess(true);
      setConfirmingSubmit(false);
      lastSyncedRef.current = { id: task.id, report: inlineReport, hours: inlineHours };
      toast.success(mode === 'submit' ? "Submitted for review. The task is now locked until your reviewer decides." : "Draft saved. Nothing was sent for review — click 'Submit for review' when ready.");
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      setTimeout(() => { setIsSuccess(false); setIsUpdating(false); onTaskUpdated(); }, 1500);
    } catch (err) { toast.error("Submit failed. Please try again."); setIsUpdating(false); }
  };

  const existingFileCount = Array.isArray(task.deliverableFiles) ? task.deliverableFiles.length : 0;
  const attachedFileCount = existingFileCount + uploadedFiles.length;
  // Submission readiness: the two things a submission needs. The buttons
  // below adapt to this automatically — no status hunting required.
  const fileDone = attachedFileCount > 0;
  const reportDone = inlineReport.trim().length > 0;
  const submitReady = fileDone && reportDone;
  const stepsDone = (fileDone ? 1 : 0) + (reportDone ? 1 : 0);
  const missingHint = !fileDone && !reportDone
    ? 'To submit: attach a proof file and write your work report.'
    : !fileDone
      ? 'To submit: attach a proof file.'
      : 'To submit: write your work report.';
  // Late-penalty warning for the pre-submit summary: the server deducts
  // penaltyPoints from the points a task is worth when it is approved after
  // its deadline (see src/lib/server/gamification-transaction.ts), never
  // below zero. Warn when the deadline has already passed and the task
  // carries a non-zero penalty with points to lose.
  const summaryDeadline = safeDate(task.individualDeadline) || safeDate(task.deadline);
  const showSummaryLatePenalty =
    !!summaryDeadline && summaryDeadline.getTime() < Date.now() &&
    typeof task.penaltyPoints === 'number' && task.penaltyPoints > 0 &&
    typeof task.points === 'number' && task.points > 0;

  return (
    <>
              {/* ── SITREP Panel (full width, below briefing) ── */}
              <div>
                {canEdit ? (
                  <div className="rounded-2xl border border-border/50 overflow-hidden shadow-2xl shadow-black/40 bg-card">
                    {/* Panel header */}
                    <div className="relative px-6 py-4 border-b border-border/60 bg-gradient-to-r from-emerald-500/8 via-cyan-500/5 to-transparent">
                      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-500/5 to-transparent" />
                      <h4 className="relative text-xs font-black uppercase tracking-[0.35em] text-emerald-400 flex items-center gap-2.5">
                        <div className="h-6 w-6 rounded-lg bg-emerald-500/15 flex items-center justify-center"><RefreshCw className="h-3.5 w-3.5" /></div>
                        Your progress report
                      </h4>
                    </div>

                    <div className="p-5 space-y-5">
                      {task.status === 'submitted-for-review' ? (
                        /* Locked while under review - no silent edits */
                        <div className="space-y-4">
                          <div className="text-center py-8 bg-amber-500/5 border border-dashed border-amber-500/30 rounded-2xl px-4">
                            <p className="text-amber-300 font-black uppercase tracking-widest text-xs">Submitted for review</p>
                            <p className="text-muted-foreground text-xs mt-2 leading-relaxed">
                              Your report is locked while your reviewer looks it over. You will get a notification when they approve it or ask for changes. To keep working on it, withdraw your submission below.
                            </p>
                          </div>
                          {/* Read-only view of the assignee's own submission while locked.
                              No edit or resubmit actions here; withdrawing is the only way back. */}
                          <details className="group rounded-2xl border border-border/60 bg-card/40 overflow-hidden">
                            <summary className="flex items-center justify-between gap-2 px-4 py-3 cursor-pointer list-none text-xs font-black uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors min-h-[44px]">
                              <span>What you submitted</span>
                              <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="px-4 pb-4 pt-4 border-t border-border/40 space-y-4">
                              <div>
                                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1.5">Your report</p>
                                {task.report ? (
                                  <p className="text-foreground/90 text-sm leading-relaxed whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 max-h-60 overflow-y-auto">{task.report}</p>
                                ) : (
                                  <p className="text-sm text-muted-foreground">No report text on this submission.</p>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                                {typeof task.hoursWorked === 'number' && (
                                  <span><span className="font-semibold text-foreground">{task.hoursWorked} hours logged</span></span>
                                )}
                                {safeDate(task.submittedAt) && (
                                  <span>Submitted {format(safeDate(task.submittedAt)!, 'MMM dd, yyyy · h:mm a')}</span>
                                )}
                              </div>
                              {(() => {
                                const rawLinks = task.resourceLinks;
                                const links: string[] = Array.isArray(rawLinks)
                                  ? rawLinks.filter((l: any) => typeof l === 'string' && l.trim().length > 0)
                                  : (typeof rawLinks === 'string' ? rawLinks.split('\n').map((l: string) => l.trim()).filter(Boolean) : []);
                                const files = (Array.isArray(task.deliverableFiles) ? task.deliverableFiles : [])
                                  .filter((f: any) => f && typeof f.downloadUrl === 'string' && f.downloadUrl.length > 0);
                                if (links.length === 0 && files.length === 0) return null;
                                return (
                                  <div className="space-y-3">
                                    {links.length > 0 && (
                                      <div>
                                        <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1.5">Proof links</p>
                                        <div className="space-y-1.5">
                                          {links.map((link: string, idx: number) => (
                                            <a key={idx} href={link.startsWith('http') ? link : `https://${link}`} target="_blank" rel="noopener noreferrer"
                                              className="flex items-center gap-2 text-xs text-primary hover:underline break-all">
                                              <ExternalLink className="h-3 w-3 shrink-0" /> {link}
                                            </a>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {files.length > 0 && (
                                      <div>
                                        <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1.5">Deliverable files</p>
                                        <div className="space-y-1.5">
                                          {files.map((file: any, idx: number) => (
                                            <a key={file.driveFileId || `file-${idx}`} href={file.downloadUrl} target="_blank" rel="noopener noreferrer"
                                              className="flex items-center gap-2 text-xs text-primary hover:underline break-all">
                                              <ExternalLink className="h-3 w-3 shrink-0" /> {file.fileName || 'Deliverable file'}
                                            </a>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          </details>
                          <SubmitButton onClick={handleRecall} isSubmitting={isUpdating} isSuccess={isSuccess}
                            className="w-full h-11 bg-muted text-muted-foreground font-black uppercase tracking-[0.15em] text-xs rounded-xl hover:bg-slate-700 transition-all border border-border">
                            Withdraw and keep editing
                          </SubmitButton>
                        </div>
                      ) : (
                      <>
                      {/* Reviewer feedback - visible so revision requests are actionable */}
                      {task.status === 'changes-requested' && task.feedback_history && task.feedback_history.length > 0 && (
                        <div className="bg-amber-500/10 border border-amber-500/40 p-4 rounded-xl">
                          <p className="text-xs font-black text-amber-400 uppercase tracking-widest mb-2">Reviewer feedback</p>
                          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
                            {task.feedback_history[task.feedback_history.length - 1].text}
                          </p>
                        </div>
                      )}
                      {/* Proof requirements: surfaced before the submitter fills anything in */}
                      <SubmissionChecklist task={task} />
                      {/* Submission progress — replaces the old status picker. The
                          buttons below adapt to this automatically. */}
                      <div className="space-y-2">
                        <label className="text-xs font-black text-muted-foreground uppercase tracking-widest ml-1">
                          {stepsDone} of 2 steps done{submitReady ? ' — ready to submit' : ''}
                        </label>
                        <div className="rounded-xl border border-border/80 bg-card p-3 space-y-2">
                          <SubmissionStepRow done={fileDone} label={fileDone ? `Proof file attached (${attachedFileCount})` : 'Attach a proof file'} />
                          <SubmissionStepRow done={reportDone} label="Work report written" />
                        </div>
                      </div>

                      {/* Hours - Stepper input */}
                      <div className="space-y-2">
                        <label className="text-xs font-black text-muted-foreground uppercase tracking-widest ml-1">Hours Logged <span className="font-semibold normal-case tracking-normal text-muted-foreground">(optional)</span></label>
                        <div className="flex items-center bg-card border border-border/80 rounded-xl p-1">
                          <button onClick={() => setInlineHours(String(Math.max(0, (parseFloat(inlineHours) || 0) - 0.5)))}
                            className="h-11 w-11 rounded-lg bg-muted hover:bg-slate-700 text-muted-foreground hover:text-foreground flex items-center justify-center font-black text-base transition-all shrink-0">-</button>
                          <Input type="number" step="0.5" value={inlineHours} onChange={e => setInlineHours(e.target.value)}
                            className="flex-1 bg-transparent border-0 text-center text-xl font-black font-mono h-11 focus-visible:ring-0 focus-visible:ring-offset-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                          <button onClick={() => setInlineHours(String((parseFloat(inlineHours) || 0) + 0.5))}
                            className="h-11 w-11 rounded-lg bg-muted hover:bg-slate-700 text-muted-foreground hover:text-foreground flex items-center justify-center font-black text-base transition-all shrink-0">+</button>
                        </div>
                        <p className="text-xs text-muted-foreground ml-1">Rough time you spent on this task, recorded on your activity log.</p>
                      </div>

                      {/* Execution Log */}
                      <div className="space-y-2">
                        <label className="text-xs font-black text-muted-foreground uppercase tracking-widest ml-1">Work Report <span className="font-semibold normal-case tracking-normal text-amber-400">(required to submit for review)</span></label>
                        <Textarea ref={reportRef} value={inlineReport} onChange={(e) => { setInlineReport(e.target.value); if (reportError) setReportError(null); }} rows={5}
                          placeholder="Detail outcomes, blockers, and deliverables..."
                          className="bg-card border-border/80 resize-none text-sm rounded-xl p-4 focus:ring-emerald-500/20 min-h-[120px] placeholder:text-muted-foreground" />
                        {reportError && (
                          <p role="alert" className="text-xs text-red-400 font-semibold leading-relaxed ml-1">{reportError}</p>
                        )}
                      </div>

                      {/* Proof files — real uploads into the SEDS Drive folder, not link pasting */}
                      <DeliverableUploader
                        context={`task-${task.id}`}
                        taskId={task.id}
                        existingFiles={Array.isArray(task.deliverableFiles) ? task.deliverableFiles : []}
                        onChange={setUploadedFiles}
                        onUploadingChange={setFilesUploading}
                        disabled={isUpdating}
                      />

                      {/* Two explicit actions. When the work is ready, "Submit for
                          review" is the prominent primary button; otherwise
                          "Save draft" leads and submit is disabled with the
                          reason shown inline and in a tooltip. */}
                      <div className="space-y-3 pt-1">
                        {submitReady ? (
                          <>
                            <SubmitButton onClick={handleSubmitClick} isSubmitting={isUpdating} isSuccess={isSuccess}
                              aria-label={`Submit "${task.title}" for review`}
                              disabled={filesUploading}
                              className="w-full h-14 bg-gradient-to-r from-emerald-500 to-cyan-500 text-black font-black uppercase tracking-[0.15em] text-sm rounded-xl shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 hover:brightness-110 transition-all border border-border animate-pulse ring-2 ring-emerald-400 ring-offset-2 ring-offset-black">
                              Submit for review
                            </SubmitButton>
                            <Button variant="outline" onClick={handleDraftSave} disabled={isUpdating || filesUploading}
                              className="w-full h-11 rounded-xl text-xs font-black uppercase tracking-[0.15em] text-muted-foreground border-border/60">
                              Save draft
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button onClick={handleDraftSave} disabled={isUpdating || filesUploading}
                              className="w-full h-12 bg-gradient-to-r from-emerald-500 to-cyan-500 text-black font-black uppercase tracking-[0.15em] text-xs rounded-xl shadow-lg shadow-emerald-500/15 hover:shadow-emerald-500/30 hover:brightness-110 transition-all border border-border">
                              {isUpdating ? 'Saving...' : 'Save draft'}
                            </Button>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="block w-full" onClick={(e) => e.stopPropagation()}>
                                    <SubmitButton isSubmitting={false} isSuccess={false}
                                      aria-label="Submit for review (finish the steps above first)"
                                      disabled
                                      className="w-full h-12 rounded-xl text-xs font-black uppercase tracking-[0.15em] border border-border/60 bg-muted/40 text-muted-foreground cursor-not-allowed">
                                      Submit for review
                                    </SubmitButton>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[240px]">
                                  <p className="text-xs">{missingHint}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <p className="text-xs text-muted-foreground leading-relaxed">{missingHint}</p>
                          </>
                        )}
                      </div>
                      </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-8 rounded-2xl bg-card/40 border border-border/40 text-center text-sm text-muted-foreground italic">
                    Restricted to mission-critical personnel.
                  </div>
                )}
              </div>

      {/* ── Pre-submit summary (step 2 of the two-step submit) ── */}
      {confirmingSubmit && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="presubmit-title">
          <div className="absolute inset-0 bg-black/70" onClick={() => setConfirmingSubmit(false)} />
          <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-5 sm:p-6 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-black uppercase tracking-[0.25em] text-primary mb-2">Check before you submit</p>
            <h3 id="presubmit-title" className="text-lg font-black text-foreground break-words mb-4">{task.title}</h3>
            <div className="space-y-4 text-sm">
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1.5">Your report</p>
                <p className="text-foreground/90 leading-relaxed whitespace-pre-wrap break-words max-h-44 overflow-y-auto rounded-xl bg-muted/40 p-3">{inlineReport.trim()}</p>
              </div>
              <p className="text-muted-foreground">
                <span className="font-semibold text-foreground">{inlineHours || '0'} hours logged</span>
              </p>
              {(uploadedFiles.length > 0 || existingFileCount > 0) && (
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {attachedFileCount} proof file{attachedFileCount === 1 ? '' : 's'} attached
                  </span>
                </p>
              )}
              {showSummaryLatePenalty && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
                  <p className="text-xs text-red-300 leading-relaxed">
                    The deadline for this task has passed. If your reviewer approves it now, {task.penaltyPoints} of the {task.points} points will be deducted as a late penalty.
                  </p>
                </div>
              )}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Submitting locks your report until your reviewer decides. You will get a notification when they approve it or ask for changes. You can withdraw the submission afterwards to keep editing.
                </p>
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-3 mt-5">
              <Button variant="outline" className="flex-1 h-12 rounded-xl" onClick={() => setConfirmingSubmit(false)}>Go back</Button>
              <Button className="flex-1 h-12 rounded-xl bg-primary text-black font-bold hover:bg-white" onClick={(e) => handleFullUpdate(e, 'submit')} disabled={isUpdating || filesUploading}>
                {isUpdating ? 'Submitting...' : filesUploading ? 'Uploading files...' : 'Submit for review'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
