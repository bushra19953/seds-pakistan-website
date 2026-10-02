'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useUser } from '@/firebase';
import { uploadToDrive } from '@/lib/uploads/client';
import { Button } from '@/components/ui/button';
import { Loader2, UploadCloud, FileBox, XCircle, CheckCircle2 } from 'lucide-react';

/** Metadata for one CAD file after a successful vault upload. */
export interface CadUploadMeta {
  fileName: string;
  storagePath: string;
  sizeBytes: number;
  contentType: string;
  downloadUrl: string;
  driveFileId?: string;
}

interface QueuedFile {
  id: string;
  file: File;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  meta?: CadUploadMeta;
}

const MAX_BYTES = 100 * 1024 * 1024; // 100MB ceiling matching storage.rules

const MIME_BY_EXT: Record<string, string> = {
  '.step': 'model/step',
  '.stp': 'model/step',
  '.stl': 'model/stl',
  '.zip': 'application/zip',
};

const ACCEPTED_EXTS = Object.keys(MIME_BY_EXT);

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function sanitizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'general';
}

interface CadDropzoneProps {
  inquiryId: string;
  university: string;
  onFilesChange: (files: CadUploadMeta[]) => void;
  disabled?: boolean;
}

/**
 * cad-dropzone: drag-and-drop CAD package uploader for the Sourcing Bridge RFQ pipeline.
 * Uploads via the shared Drive upload helper to the "SEDS CAD Vault" folder
 * (zero-cost replacement for Firebase Storage).
 * Requires a signed-in user; the server verifies the Firebase ID token.
 */
export default function CadDropzone({ inquiryId, university, onFilesChange, disabled }: CadDropzoneProps) {
  const { user } = useUser();
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pushError = (file: File, message: string) => {
    setQueue((prev) => [
      ...prev,
      { id: `${Date.now()}-${file.name}`, file, progress: 0, status: 'error', error: message },
    ]);
  };

  const uploadOne = useCallback(
    async (queued: QueuedFile) => {
      const { file } = queued;

      if (!user) {
        setQueue((prev) =>
          prev.map((q) => (q.id === queued.id ? { ...q, status: 'error' as const, error: 'Sign in to upload.' } : q)),
        );
        return;
      }

      let idToken: string;
      try {
        idToken = await user.getIdToken();
      } catch {
        setQueue((prev) =>
          prev.map((q) => (q.id === queued.id ? { ...q, status: 'error' as const, error: 'Could not get auth token.' } : q)),
        );
        return;
      }

      setQueue((prev) => prev.map((q) => (q.id === queued.id ? { ...q, status: 'uploading' as const, progress: 0 } : q)));
      try {
        const uploaded = await uploadToDrive(file, idToken, {
          kind: 'cad',
          context: `${sanitizeSlug(university)}_${inquiryId}`.slice(0, 40),
          onProgress: (progress) => {
            setQueue((prev) => prev.map((q) => (q.id === queued.id ? { ...q, progress, status: 'uploading' as const } : q)));
          },
        });
        const meta: CadUploadMeta = {
          fileName: uploaded.fileName,
          storagePath: uploaded.storagePath,
          sizeBytes: uploaded.sizeBytes,
          contentType: uploaded.contentType,
          downloadUrl: uploaded.downloadUrl,
          driveFileId: uploaded.driveFileId,
        };
        setQueue((prev) => {
          const next = prev.map((q) => (q.id === queued.id ? { ...q, progress: 100, status: 'done' as const, meta } : q));
          onFilesChange(next.filter((q) => q.status === 'done' && q.meta).map((q) => q.meta as CadUploadMeta));
          return next;
        });
      } catch (err) {
        setQueue((prev) =>
          prev.map((q) =>
            q.id === queued.id ? { ...q, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' } : q,
          ),
        );
      }
    },
    [inquiryId, university, onFilesChange, user],
  );

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      for (const file of files) {
        const ext = extOf(file.name);
        if (!ACCEPTED_EXTS.includes(ext)) {
          pushError(file, `Unsupported file type. Accepted: ${ACCEPTED_EXTS.join(', ')}`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          pushError(file, 'File exceeds the 100MB vault limit.');
          continue;
        }
        const queued: QueuedFile = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          progress: 0,
          status: 'queued',
        };
        setQueue((prev) => [...prev, queued]);
        uploadOne(queued);
      }
    },
    [uploadOne],
  );

  const removeFromQueue = (id: string) => {
    setQueue((prev) => {
      const next = prev.filter((q) => q.id !== id);
      onFilesChange(next.filter((q) => q.status === 'done' && q.meta).map((q) => q.meta as CadUploadMeta));
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        aria-label="CAD file dropzone"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (!disabled && e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-8 text-center transition-colors cursor-pointer ${
          isDragging ? 'border-cyan-400 bg-cyan-400/10' : 'border-border bg-card/60 hover:border-primary/60'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTS.join(',')}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <UploadCloud className="w-10 h-10 mx-auto mb-3 text-primary" />
        <p className="text-foreground font-accent text-sm uppercase tracking-wider mb-1">
          Drag and drop CAD packages here, or click to browse
        </p>
        <p className="text-muted-foreground text-xs font-body">
          Accepted formats: .step, .stp, .stl, .zip. Maximum 100MB per file. Uploads go directly to the secure CAD vault.
        </p>
      </div>

      {queue.length > 0 && (
        <ul className="space-y-2">
          {queue.map((q) => (
            <li
              key={q.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-card/80 px-4 py-3"
            >
              {q.status === 'done' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              ) : q.status === 'error' ? (
                <XCircle className="w-5 h-5 text-destructive shrink-0" />
              ) : (
                <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground font-body truncate flex items-center gap-2">
                  <FileBox className="w-4 h-4 shrink-0 text-muted-foreground" />
                  {q.file.name}
                </p>
                {q.status === 'uploading' || q.status === 'queued' ? (
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${q.progress}%` }} />
                  </div>
                ) : q.status === 'error' ? (
                  <p className="text-xs text-destructive font-body mt-1">{q.error}</p>
                ) : (
                  <p className="text-xs text-muted-foreground font-body mt-1">
                    {(q.meta!.sizeBytes / (1024 * 1024)).toFixed(2)} MB uploaded to vault
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => removeFromQueue(q.id)}
                aria-label={`Remove ${q.file.name}`}
              >
                <XCircle className="w-4 h-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
