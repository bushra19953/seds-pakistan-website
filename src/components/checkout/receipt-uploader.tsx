'use client';

import { useRef, useState } from 'react';
import { useUser } from '@/firebase';
import { uploadToDrive, type DriveUploadMeta } from '@/lib/uploads/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Loader2, ReceiptText, XCircle, CheckCircle2, UploadCloud } from 'lucide-react';

interface ReceiptUploaderProps {
  onUploaded: (meta: DriveUploadMeta | null) => void;
  disabled?: boolean;
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';

/**
 * ReceiptUploader: screenshot/PDF upload for manual payments (JazzCash /
 * Easypaisa / bank transfer). Uploads straight into the site's
 * "SEDS Payment Receipts" Drive folder; no Drive-link pasting needed.
 */
export default function ReceiptUploader({ onUploaded, disabled }: ReceiptUploaderProps) {
  const { user } = useUser();
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<DriveUploadMeta | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const clear = () => {
    setMeta(null);
    setError(null);
    setProgress(0);
    onUploaded(null);
  };

  const handleFile = async (file: File) => {
    setError(null);

    const okType = file.type.startsWith('image/') || file.type === 'application/pdf';
    if (!okType) {
      setError('Please upload a screenshot image or PDF.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Receipt must be under 10MB.');
      return;
    }
    if (!user) {
      setError('Sign in to upload your receipt.');
      return;
    }

    setUploading(true);
    setProgress(0);
    try {
      const idToken = await user.getIdToken();
      const uploaded = await uploadToDrive(file, idToken, {
        kind: 'receipt',
        context: 'checkout',
        onProgress: setProgress,
      });
      setMeta(uploaded);
      onUploaded(uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled || uploading) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <div className="space-y-2.5">
      <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <ReceiptText className="h-3.5 w-3.5 text-primary" />
        Proof of Payment — Upload Receipt
        <span className="text-red-400 ml-0.5">*</span>
      </Label>

      {meta ? (
        <div className="flex items-center gap-3 rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-3">
          <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground truncate">{meta.fileName}</p>
            <p className="text-xs text-muted-foreground">
              {(meta.sizeBytes / 1024).toFixed(0)} KB uploaded — our team will verify it.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={clear} aria-label="Remove receipt">
            <XCircle className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload payment receipt"
          onClick={() => !disabled && !uploading && inputRef.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !disabled && !uploading) inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled && !uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${
            dragging ? 'border-primary bg-primary/10' : 'border-border bg-card/60 hover:border-primary/60'
          } ${disabled || uploading ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            disabled={disabled || uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = '';
            }}
          />
          {uploading ? (
            <div className="space-y-3">
              <Loader2 className="w-8 h-8 mx-auto text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">Uploading receipt… {progress}%</p>
              <Progress value={progress} className="h-2 max-w-xs mx-auto" />
            </div>
          ) : (
            <>
              <UploadCloud className="w-8 h-8 mx-auto mb-2 text-primary" />
              <p className="text-sm text-foreground font-medium">Drop your payment screenshot here, or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">PNG, JPG, WEBP or PDF — max 10MB</p>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive flex items-center gap-1.5">
          <XCircle className="w-3.5 h-3.5" /> {error}
        </p>
      )}
    </div>
  );
}
