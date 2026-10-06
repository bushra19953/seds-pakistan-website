/**
 * Client-side helper for Drive-backed uploads.
 *
 * POSTs a file to /api/uploads with XHR (for progress events) using the
 * caller's Firebase ID token. Every upload kind lands in its own Drive folder.
 */

export type UploadKind = 'cad' | 'image' | 'bug' | 'document' | 'receipt' | 'video';

export interface DriveUploadMeta {
  fileName: string;
  driveFileId: string;
  storagePath: string;
  sizeBytes: number;
  contentType: string;
  downloadUrl: string;
  kind: UploadKind;
}

interface UploadOptions {
  kind: UploadKind;
  /** Namespaces the stored filename, e.g. an inquiry id or user id. */
  context?: string;
  /** Extra form fields to send alongside the file. */
  fields?: Record<string, string>;
  onProgress?: (percent: number) => void;
}

/**
 * Upload a file to the Drive-backed /api/uploads endpoint.
 * Resolves with the stored file metadata; rejects with an Error message.
 */
export function uploadToDrive(
  file: File,
  idToken: string,
  { kind, context, fields, onProgress }: UploadOptions,
): Promise<DriveUploadMeta> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('kind', kind);
    if (context) form.append('context', context);
    if (fields) {
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status === 201 || xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve({
            fileName: data.fileName,
            driveFileId: data.driveFileId,
            storagePath: data.storagePath,
            sizeBytes: data.sizeBytes ?? file.size,
            contentType: data.contentType || file.type,
            downloadUrl: data.downloadUrl || '',
            kind: data.kind || kind,
          });
        } catch {
          reject(new Error('Invalid server response.'));
        }
      } else {
        let message = 'Upload failed';
        try {
          const data = JSON.parse(xhr.responseText);
          if (data?.error) message = data.error;
        } catch {
          /* keep default */
        }
        if (xhr.status === 401) message = 'Session expired. Sign in again to upload.';
        reject(new Error(message));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(form);
  });
}
