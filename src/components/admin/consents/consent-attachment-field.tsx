'use client';

import { useRef, useState } from 'react';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Loader2, Paperclip, X } from 'lucide-react';
import { uploadToDrive } from '@/lib/uploads/client';
import type { ConsentAttachment } from '@/types/consent';

interface Props {
  value: ConsentAttachment[];
  onChange: (next: ConsentAttachment[]) => void;
  /** When true the list is read-only (e.g. after a decision). */
  readOnly?: boolean;
  /** Existing decision-frozen attachments render without a remove button. */
  allowRemove?: boolean;
}

const MAX_ATTACHMENTS = 10;

/**
 * Attachment picker for Consent requests. Uses the platform's existing
 * Drive upload flow (POST /api/uploads/initiate, browser PUT,
 * POST /api/uploads/complete via uploadToDrive) and stores only the
 * reference object on the request - never the file itself.
 */
export default function ConsentAttachmentField({
  value,
  onChange,
  readOnly = false,
  allowRemove = true,
}: Props) {
  const { user } = useUser();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const atCap = value.length >= MAX_ATTACHMENTS;

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user) return;
    setError(null);
    setUploading(true);
    try {
      const token = await user.getIdToken();
      const next = [...value];
      for (const file of Array.from(files)) {
        if (next.length >= MAX_ATTACHMENTS) break;
        const meta = await uploadToDrive(file, token, {
          kind: 'document',
          context: 'consent-request',
        });
        next.push({
          fileName: meta.fileName,
          driveFileId: meta.driveFileId,
          downloadUrl: meta.downloadUrl,
          sizeBytes: meta.sizeBytes,
          contentType: meta.contentType,
          uploadedByUid: user.uid,
          uploadedAt: new Date().toISOString(),
        });
      }
      onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Try again.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {value.map((att) => (
          <div
            key={att.driveFileId}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <a
              href={att.downloadUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 underline-offset-2 hover:underline"
            >
              <Paperclip className="h-4 w-4" />
              {att.fileName}
            </a>
            {!readOnly && allowRemove && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange(value.filter((a) => a.driveFileId !== att.driveFileId))
                }
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {value.length === 0 && (
          <p className="text-sm text-muted-foreground">No attachments.</p>
        )}
      </div>
      {!readOnly && (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading || atCap}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="mr-2 h-4 w-4" />
            )}
            Add attachment
          </Button>
          <p className="text-xs text-muted-foreground">
            {value.length} of {MAX_ATTACHMENTS} attachments. Files are stored in
            Google Drive through the platform upload flow; only the reference is
            kept on the request.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}
