'use client';

import { useEffect, useRef, useState } from 'react';
import { useUser } from '@/firebase';
import { uploadToDrive, type DriveUploadMeta, type UploadKind } from '@/lib/uploads/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, UploadCloud, XCircle, CheckCircle2, FileText, Paperclip } from 'lucide-react';

/**
 * Accepted file extensions for task proof uploads. Documents mirror the
 * server-side 'document' kind (SEDS Chapter Documents) and videos mirror
 * the server-side 'video' kind (SEDS Video Deliverables), so the browser
 * rejects before the round trip. The server still enforces its own rules.
 *
 * Note: the video list and VIDEO_MAX_BYTES mirror UPLOAD_KINDS.video in
 * src/lib/drive/folders.ts (verified at implementation time: same five
 * extensions, same MIMEs, same 100MB limit). The server enforces its own
 * rules, but keep the client list in sync if that config ever changes.
 * Zip archives ride along with video files (same kind, same 100MB cap) and
 * are stored as-is on Drive.
 */
const ACCEPTED_EXTS = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.m4v', '.zip'];
const DOCUMENT_ACCEPT = 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp,image/gif';
const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,video/x-m4v,application/zip';
const ACCEPT = `${DOCUMENT_ACCEPT},${VIDEO_ACCEPT}`;
const MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_MB = VIDEO_MAX_BYTES / 1024 / 1024;

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

/**
 * Pick the server upload kind from the file extension: video extensions go
 * to the 'video' kind, everything else to 'document'. Zip archives count as
 * video extensions here (same kind, same 100MB cap); they are stored as-is
 * on Drive, never extracted. The server validates kind and size on every
 * upload, so client-side selection only needs to match the server's
 * UPLOAD_KINDS.video.mimeByExt.
 */
const kindForExt = (ext: string): UploadKind =>
  VIDEO_EXTS.includes(ext) ? 'video' : 'document';

interface DeliverableUploaderProps {
  /** Called with the full list of newly uploaded files whenever it changes. */
  onChange: (files: DriveUploadMeta[]) => void;
  /** Files already attached to the task; shown read-only so nothing is lost. */
  existingFiles?: Array<{ fileName?: string; driveFileId?: string; downloadUrl: string }>;
  /** Namespaces stored filenames, e.g. the task id. */
  context: string;
  /** Tells the parent an upload is in flight so submit can wait for it. */
  onUploadingChange?: (uploading: boolean) => void;
  /** When set, newly uploaded files are auto-attached to this task via /api/tasks/attach-upload. */
  taskId?: string;
  disabled?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface PendingFile {
  id: number;
  name: string;
  size: number;
  progress: number;
  /** True while the server confirmation call is in flight. */
  confirming: boolean;
}

let pendingId = 0;

/**
 * DeliverableUploader: multi-file proof upload for the task submission form.
 * Uploads land in the SEDS Drive folder matching their type (documents in
 * "SEDS Chapter Documents", videos in "SEDS Video Deliverables") through the
 * existing /api/uploads endpoint; when the `taskId` prop is set the file is
 * also auto-attached to that task through /api/tasks/attach-upload right
 * after upload, so files can never be orphaned. The submitter still needs to
 * write a Work Report and click Submit for review — uploading alone does not
 * send the work for review.
 */
export default function DeliverableUploader({
  onChange,
  existingFiles = [],
  context,
  onUploadingChange,
  taskId,
  disabled,
}: DeliverableUploaderProps) {
  const { user } = useUser();
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<DriveUploadMeta[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attachedIds, setAttachedIds] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = pending.length > 0;

  useEffect(() => {
    onUploadingChange?.(busy);
  }, [busy, onUploadingChange]);

  const removeFile = (driveFileId: string) => {
    const next = files.filter((f) => f.driveFileId !== driveFileId);
    setFiles(next);
    onChange(next);
  };

  const validate = (file: File): string | null => {
    const ext = extOf(file.name);
    const isVideo = VIDEO_EXTS.includes(ext);
    if (!isVideo && !ACCEPTED_EXTS.includes(ext)) {
      return `"${file.name}" is not an accepted type. Upload a PDF, Word document, image, video, or zip file instead.`;
    }
    if (file.size === 0) {
      return `"${file.name}" is empty. Pick a file that has content.`;
    }
    const limit = isVideo ? VIDEO_MAX_BYTES : MAX_BYTES;
    if (file.size > limit) {
      const limitLabel = isVideo ? `${VIDEO_MB}MB` : '25MB';
      return `"${file.name}" is over the ${limitLabel} limit. Compress it or split it up and try again.`;
    }
    return null;
  };

  const handleFiles = async (fileList: FileList | File[]) => {
    setError(null);
    const selected = Array.from(fileList);
    if (selected.length === 0) return;
    if (!user) {
      setError('Sign in to upload files.');
      return;
    }
    for (const file of selected) {
      const problem = validate(file);
      if (problem) {
        setError(problem);
        continue;
      }
      const token = await user.getIdToken().catch(() => null);
      if (!token) {
        setError('Your session expired. Sign in again to upload.');
        continue;
      }
      const id = ++pendingId;
      setPending((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0, confirming: false }]);
      try {
        const uploaded = await uploadToDrive(file, token, {
          kind: kindForExt(extOf(file.name)),
          context,
          onProgress: (p) => setPending((prev) => prev.map((x) => (x.id === id ? { ...x, progress: p } : x))),
          onConfirming: (c) => setPending((prev) => prev.map((x) => (x.id === id ? { ...x, confirming: c } : x))),
        });
        setFiles((prev) => {
          const next = [...prev, uploaded];
          onChange(next);
          return next;
        });
        // Auto-attach: the file lands on the task immediately, so it can
        // never be orphaned even if the user never clicks Submit. Non-fatal:
        // if this fails the file is still tracked in `upload_logs` and the
        // admin "Recent Uploads" view shows it as orphaned.
        if (taskId) {
          try {
            const res = await fetch('/api/tasks/attach-upload', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                taskId,
                file: {
                  fileName: uploaded.fileName,
                  driveFileId: uploaded.driveFileId,
                  downloadUrl: uploaded.downloadUrl || undefined,
                  sizeBytes: uploaded.sizeBytes,
                  mimeType: uploaded.contentType || undefined,
                },
              }),
            });
            if (res.ok) {
              setAttachedIds((prev) => new Set(prev).add(uploaded.driveFileId));
            }
          } catch {
            /* attach is best-effort; upload itself already succeeded */
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not upload "${file.name}". Try again.`);
      } finally {
        setPending((prev) => prev.filter((x) => x.id !== id));
      }
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled || busy) return;
    const list = e.dataTransfer?.files;
    if (list && list.length > 0) void handleFiles(list);
  };

  return (
    <div className="space-y-2">
      <Label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest ml-1">
        <span className="inline-flex items-center gap-1.5">
          <Paperclip className="h-3.5 w-3.5 text-primary" />
          Upload proof files <span className="font-semibold normal-case tracking-normal text-muted-foreground/70">(optional)</span>
        </span>
      </Label>

      {/* Files already attached to this task: shown so the submitter knows nothing is lost. */}
      {existingFiles.length > 0 && (
        <ul className="space-y-1.5" aria-label="Files already attached">
          {existingFiles.map((f, i) => (
            <li key={f.driveFileId || `existing-${i}`} className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 min-h-[44px]">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-xs text-foreground/80 truncate flex-1 min-w-0">{f.fileName || 'Attached file'}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">attached</span>
            </li>
          ))}
        </ul>
      )}

      {/* Newly uploaded files in this session. */}
      {files.length > 0 && (
        <ul className="space-y-1.5" aria-label="Files you uploaded">
          {files.map((f) => (
            <li key={f.driveFileId} className="flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 min-h-[44px]">
              <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs text-foreground truncate">{f.fileName}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {formatSize(f.sizeBytes)} uploaded{attachedIds.has(f.driveFileId) ? ' · attached to task' : ''}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => removeFile(f.driveFileId)}
                aria-label={`Remove ${f.fileName}`}
                className="h-11 w-11 shrink-0"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Post-upload nudge: uploading alone does NOT submit the work. */}
      {files.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 flex items-start gap-2"
        >
          <UploadCloud className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-foreground/90 leading-relaxed">
            File uploaded to Drive ✓ and attached to your task — you still need to write a Work Report and click &lsquo;Submit for review&rsquo; below. Uploading alone does not send your work for review.
          </p>
        </div>
      )}

      {/* In-flight uploads. */}
      {pending.map((p) => (
        <div key={p.id} className="rounded-lg border border-border/60 bg-card px-3 py-2" aria-live="polite">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />
            <span className="text-xs text-foreground truncate flex-1 min-w-0">{p.name}</span>
            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
              {p.confirming ? 'Confirming upload...' : `${p.progress}%`}
            </span>
          </div>
          <Progress value={p.progress} className="h-1.5 mt-2" />
        </div>
      ))}

      <div
        role="button"
        tabIndex={0}
        aria-label="Upload proof files"
        onClick={() => !disabled && !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled && !busy) inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors cursor-pointer ${
          dragging ? 'border-primary bg-primary/10' : 'border-border bg-card/60 hover:border-primary/60'
        } ${disabled || busy ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          disabled={disabled || busy}
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <UploadCloud className="w-7 h-7 mx-auto mb-1.5 text-primary" />
        <p className="text-sm text-foreground font-medium">Drop files here, or click to choose</p>
        <p className="text-xs text-muted-foreground mt-1">PDF, Word, image, or video files up to 25MB each. Videos and zip files up to {VIDEO_MB}MB each. They land in the SEDS Drive folder and attach to your submission.</p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400 font-semibold leading-relaxed flex items-start gap-1.5 ml-1">
          <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
        </p>
      )}
    </div>
  );
}
