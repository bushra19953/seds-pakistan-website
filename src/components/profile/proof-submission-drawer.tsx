'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { useUser } from '@/firebase';
import { uploadToDrive, type DriveUploadMeta } from '@/lib/uploads/client';
import {
  MAX_PROOF_BYTES,
  MAX_PROOF_MB,
  PROOF_ACCEPT_MIME,
  assigneeIdsOf,
  assigneeSubmissionStates,
  proofPreviewKind,
  submissionReadiness,
  validateProofFile,
} from '@/lib/proof-submission';
import { toast } from 'sonner';
import {
  CheckCircle2,
  CloudUpload,
  FileText,
  Loader2,
  Paperclip,
  Send,
  X,
} from 'lucide-react';

/**
 * ProofSubmissionDrawer: a dedicated slide-in drawer on the member task view.
 * It is the one place for submitting proof on a task, replacing the
 * upload-and-submit path inside the complex task detail modal for most users.
 *
 * Drag-and-drop accepts images, PDFs, and videos up to 50MB. Uploads go to
 * the SEDS Drive folder through /api/uploads and are attached immediately
 * through /api/tasks/attach-upload (which reuses
 * shouldAutoTransitionOnProofUpload from bug4-proof-guards.ts, so this file
 * never duplicates the auto-transition logic).
 *
 * Save Draft writes the notes (work report) and keeps the task status as-is.
 * Submit for Review flips the status to submitted-for-review; the server
 * stamps submittedBy/submittedAt and the overdue crons skip proof-bearing
 * tasks, which pauses the overdue SLA while the submission waits for review.
 *
 * No em dashes anywhere in this file; user-facing text follows the house rule.
 */

interface AssigneeProfile {
  name?: string;
  photoURL?: string;
}

export interface ProofSubmissionDrawerProps {
  task: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** uid -> { name, photoURL }, e.g. from the workflow assignee info. */
  assigneeInfo?: Record<string, AssigneeProfile>;
  /** Refetch the task list after a successful save/submit. */
  onTaskUpdated?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface SessionUpload {
  id: number;
  name: string;
  size: number;
  progress: number;
}

let sessionUploadId = 0;

/**
 * Inline preview for one deliverable file: images render as thumbnails,
 * videos get a player, PDFs get an iframe, everything else gets a link.
 */
export function ProofPreview({ file }: { file: { fileName?: string; downloadUrl: string; contentType?: string } }) {
  const kind = proofPreviewKind(file.fileName || '', file.contentType);
  if (kind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={file.downloadUrl} alt={file.fileName || 'Proof image'} className="h-16 w-16 rounded-lg object-cover border border-border" loading="lazy" />;
  }
  if (kind === 'video') {
    return (
      <video src={file.downloadUrl} className="h-16 w-28 rounded-lg object-cover border border-border bg-black" preload="metadata" playsInline muted aria-label={file.fileName || 'Proof video'} />
    );
  }
  if (kind === 'pdf') {
    return (
      <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer" className="flex h-16 w-16 items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10" title={`Open ${file.fileName || 'PDF'} in a new tab`}>
        <FileText className="h-7 w-7 text-red-400" />
      </a>
    );
  }
  return (
    <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer" className="flex h-16 w-16 items-center justify-center rounded-lg border border-border bg-muted/40" title={file.fileName || 'Open file'}>
      <Paperclip className="h-6 w-6 text-muted-foreground" />
    </a>
  );
}

/** Avatars for every assignee, with a per-person submitted/not-submitted check-in. */
export function AssigneePresenceRow({
  task,
  assigneeInfo = {},
  currentUserId,
}: {
  task: any;
  assigneeInfo?: Record<string, AssigneeProfile>;
  currentUserId?: string;
}) {
  const ids = assigneeIdsOf(task);
  const states = assigneeSubmissionStates(task);
  if (ids.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 p-4">
      <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground mb-3">
        Assignee check-ins ({states.filter((s) => s.submitted).length}/{states.length} submitted)
      </p>
      <div className="space-y-2.5">
        {states.map((s) => {
          const info = assigneeInfo[s.assigneeId] || {};
          const name =
            info.name ||
            (s.assigneeId === task.assigneeId ? task.assigneeName : undefined) ||
            (s.assigneeId === currentUserId ? 'You' : `Member ${s.assigneeId.slice(0, 6)}`);
          const initials = (name || '?')
            .split(/\s+/)
            .map((w: string) => w[0])
            .join('')
            .slice(0, 2)
            .toUpperCase();
          return (
            <div key={s.assigneeId} className="flex items-center gap-3">
              <div className="relative shrink-0">
                <Avatar className="h-9 w-9 border border-border">
                  <AvatarImage src={info.photoURL || (s.assigneeId === task.assigneeId ? task.assigneePhoto : undefined)} alt={name} />
                  <AvatarFallback className="text-xs font-black">{initials}</AvatarFallback>
                </Avatar>
                {s.submitted && (
                  <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center" title="Submitted">
                    <CheckCircle2 className="h-3 w-3 text-black" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {name}
                  {s.assigneeId === currentUserId && <span className="ml-1.5 text-xs text-primary font-black uppercase">You</span>}
                </p>
                <p className={`text-xs font-bold uppercase tracking-widest ${s.submitted ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                  {s.submitted ? (s.via === 'submit' ? 'Submitted for review' : 'Proof uploaded') : 'Not submitted yet'}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ProofSubmissionDrawer({
  task,
  open,
  onOpenChange,
  assigneeInfo = {},
  onTaskUpdated,
}: ProofSubmissionDrawerProps) {
  const { user } = useUser();
  const [notes, setNotes] = useState(task?.report || '');
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<SessionUpload[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<DriveUploadMeta[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingCount = uploads.length;

  useEffect(() => {
    if (open && task) {
      setNotes(task.report || '');
      setNotesError(null);
      setError(null);
      setSessionFiles([]);
      setAttached([]);
    }
  }, [open, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const existingFiles: Array<{ fileName?: string; driveFileId?: string; downloadUrl: string; contentType?: string }> =
    Array.isArray(task?.deliverableFiles) ? task.deliverableFiles : [];

  const attachFile = useCallback(
    async (meta: DriveUploadMeta) => {
      const token = await user?.getIdToken().catch(() => null);
      if (!token || !task?.id) return;
      // Immediate attach through the shared endpoint, so a file can never
      // be orphaned if the member closes the drawer. The endpoint reuses
      // the conservative auto-transition guard from bug4-proof-guards.ts.
      try {
        await fetch('/api/tasks/attach-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            taskId: task.id,
            file: {
              fileName: meta.fileName,
              driveFileId: meta.driveFileId,
              downloadUrl: meta.downloadUrl || undefined,
              sizeBytes: meta.sizeBytes,
              mimeType: meta.contentType || undefined,
            },
          }),
        });
        setAttached((prev) => (prev.includes(meta.driveFileId) ? prev : [...prev, meta.driveFileId]));
        onTaskUpdated?.();
      } catch {
        // Best effort: the upload itself succeeded and the file is listed
        // in this session, so it is not lost. The save/submit PATCH below
        // merges it into deliverableFiles as a fallback.
      }
    },
    [task?.id, user, onTaskUpdated],
  );

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      setError(null);
      const selected = Array.from(fileList);
      if (selected.length === 0) return;
      if (!user) {
        setError('Sign in to upload files.');
        return;
      }
      const token = await user.getIdToken().catch(() => null);
      if (!token) {
        setError('Your session expired. Sign in again to upload.');
        return;
      }
      for (const file of selected) {
        const problem = validateProofFile(file.name, file.size, MAX_PROOF_BYTES);
        if (problem) {
          setError(problem);
          continue;
        }
        const id = ++sessionUploadId;
        setUploads((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0 }]);
        try {
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          const uploaded = await uploadToDrive(file, token, {
            kind: ['mp4', 'mov', 'webm', 'm4v'].includes(ext) ? 'video' : 'document',
            context: `task-${task?.id}`,
            onProgress: (p) => setUploads((prev) => prev.map((x) => (x.id === id ? { ...x, progress: p } : x))),
          });
          setSessionFiles((prev) => [...prev, uploaded]);
          await attachFile(uploaded);
        } catch (err) {
          setError(err instanceof Error ? err.message : `Could not upload "${file.name}". Try again.`);
        } finally {
          setUploads((prev) => prev.filter((x) => x.id !== id));
        }
      }
    },
    [user, task?.id, attachFile],
  );

  /** Merge session uploads into the task's files (dedup by driveFileId). */
  const buildDeliverableFiles = useCallback(() => {
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
    existingFiles.forEach(push);
    sessionFiles.forEach(push);
    return merged;
  }, [existingFiles, sessionFiles]);

  const patchTask = useCallback(
    async (mode: 'draft' | 'submit') => {
      if (mode === 'submit') {
        if (!notes.trim()) {
          setNotesError('Write your submission notes before submitting for review.');
          return;
        }
        if (buildDeliverableFiles().length === 0) {
          setError('Attach at least one proof file before submitting for review.');
          return;
        }
      }
      const busy = mode === 'submit' ? setSubmitting : setSaving;
      busy(true);
      try {
        const token = await user?.getIdToken();
        if (!token) throw new Error('Your session expired. Sign in again.');
        const updates: Record<string, any> = { report: notes };
        // Submitting moves the task into the review queue. The server
        // stamps submittedBy/submittedAt on this transition and fans out to
        // the validator chain; the overdue crons skip proof-bearing tasks,
        // which pauses the overdue SLA while the review is pending.
        if (mode === 'submit') updates.status = 'submitted-for-review';
        const merged = buildDeliverableFiles();
        if (merged.length > 0) updates.deliverableFiles = merged;
        const res = await fetch('/api/tasks', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.id, updates }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Save failed. Try again.');
        toast.success(
          mode === 'submit'
            ? 'Submitted for review. Your reviewer will be notified.'
            : 'Draft saved. Nothing was sent for review.',
        );
        onOpenChange(false);
        onTaskUpdated?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      } finally {
        busy(false);
      }
    },
    [notes, user, task?.id, buildDeliverableFiles, onOpenChange, onTaskUpdated],
  );

  if (!task) return null;

  const readiness = submissionReadiness({ deliverableFiles: buildDeliverableFiles() }, notes);
  const busy = saving || submitting || uploadingCount > 0;
  const deadline = task.individualDeadline || task.deadline;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col gap-0 p-0"
        aria-label={`Submit proof for ${task.title || 'task'}`}
      >
        <SheetHeader className="px-5 pt-5 pb-4 border-b border-border/60 text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={task.status} size="xs" />
            {deadline && (
              <Badge variant="outline" className="text-xs font-bold uppercase tracking-widest">
                Due {new Date(deadline?.toDate ? deadline.toDate() : deadline).toLocaleDateString()}
              </Badge>
            )}
          </div>
          <SheetTitle className="text-lg font-black tracking-tight break-words pr-8 mt-2">
            {task.title || 'Submit proof'}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Upload your proof files and notes. Submitting sends the task to your reviewer.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <AssigneePresenceRow task={task} assigneeInfo={assigneeInfo} currentUserId={user?.uid} />

          {/* Drop zone */}
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground mb-2">
              Proof files <span className="normal-case tracking-normal font-semibold">(images, PDF, video, up to {MAX_PROOF_MB}MB each)</span>
            </p>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload proof files. Drop files here or press Enter to browse."
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (busy) return;
                const list = e.dataTransfer?.files;
                if (list && list.length > 0) void handleFiles(list);
              }}
              className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors cursor-pointer ${
                dragging ? 'border-primary bg-primary/10' : 'border-border/60 bg-card/40 hover:border-primary/50'
              }`}
            >
              <CloudUpload className="h-8 w-8 text-primary" />
              <p className="text-sm font-bold text-foreground">Drop files here, or click to browse</p>
              <p className="text-xs text-muted-foreground">PNG, JPG, WebP, GIF, PDF, MP4, MOV, WebM. Max {MAX_PROOF_MB}MB per file.</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={PROOF_ACCEPT_MIME}
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const list = e.target.files;
                if (list && list.length > 0) void handleFiles(list);
                e.target.value = '';
              }}
            />

            {/* In-flight uploads */}
            {uploads.map((u) => (
              <div key={u.id} className="mt-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  <span className="font-semibold truncate flex-1">{u.name}</span>
                  <span className="text-muted-foreground shrink-0">{u.progress}%</span>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${u.progress}%` }} />
                </div>
              </div>
            ))}

            {/* Attached files (existing + this session) */}
            {buildDeliverableFiles().length > 0 && (
              <ul className="mt-3 space-y-2" aria-label="Attached proof files">
                {buildDeliverableFiles().map((f, i) => (
                  <li key={f.driveFileId || `file-${i}`} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2">
                    <ProofPreview file={f} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{f.fileName || 'Proof file'}</p>
                      <p className="text-xs text-muted-foreground">
                        {f.sizeBytes ? `${formatSize(f.sizeBytes)} · ` : ''}attached
                      </p>
                    </div>
                    <a
                      href={f.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-bold text-primary underline underline-offset-2 shrink-0"
                    >
                      Open
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-red-400 font-semibold leading-relaxed">
                {error}
              </p>
            )}
          </div>

          {/* Submission notes */}
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground mb-2">
              Submission notes <span className="text-amber-400">(required to submit)</span>
            </p>
            <Textarea
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                if (notesError) setNotesError(null);
              }}
              rows={5}
              placeholder="What did you build, measure, or finish? List outcomes, blockers, and where the proof is."
              className="resize-none text-sm rounded-xl min-h-[120px]"
            />
            {notesError && (
              <p role="alert" className="mt-1.5 text-xs text-red-400 font-semibold">
                {notesError}
              </p>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="border-t border-border/60 px-5 py-4 space-y-2.5 bg-card/40">
          {!readiness.ready && readiness.missingHint && (
            <p className="text-xs text-muted-foreground leading-relaxed">{readiness.missingHint}</p>
          )}
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1 h-12 rounded-xl text-xs font-black uppercase tracking-[0.15em]"
              disabled={busy}
              onClick={() => void patchTask('draft')}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
              Save draft
            </Button>
            <Button
              className="flex-1 h-12 rounded-xl text-xs font-black uppercase tracking-[0.15em] bg-gradient-to-r from-emerald-500 to-cyan-500 text-black hover:brightness-110"
              disabled={busy || !readiness.ready}
              title={!readiness.ready ? readiness.missingHint || undefined : 'Send this task for review'}
              onClick={() => void patchTask('submit')}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
              Submit for review
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-3.5 w-3.5" /> Close
            </button>
            <p className="text-xs text-muted-foreground">Saving a draft never sends the task anywhere.</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
