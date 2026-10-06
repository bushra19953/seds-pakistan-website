/**
 * Client-side helper for Drive-backed uploads.
 *
 * Uses a resumable flow so large files bypass Vercel's 4.5MB serverless
 * request-body limit (the edge returns 413 before the function ever runs):
 *   1. POST /api/uploads/initiate (JSON) -> {uploadUrl, mimeType}
 *   2. PUT the raw file bytes straight to Google (XHR, for progress)
 *   3. POST /api/uploads/complete {kind, driveFileId} -> DriveUploadMeta
 *
 * The Firebase ID token only goes to our own API. Google sees only the
 * single-use session URL, never the user's token.
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
  /** Kept for caller compatibility; the resumable flow has no form fields. */
  fields?: Record<string, string>;
  onProgress?: (percent: number) => void;
}

interface InitiateResult {
  uploadUrl: string;
  mimeType: string;
}

/**
 * Read a JSON error body from our API. Prefers the server's specific
 * message; falls back to a generic one when the body is not JSON (e.g. a
 * gateway error page) or the session expired.
 */
function apiError(responseText: string, status: number, fallback: string): Error {
  let message = fallback;
  try {
    const data = JSON.parse(responseText);
    if (typeof data?.error === 'string' && data.error.length > 0) message = data.error;
  } catch {
    /* keep fallback */
  }
  if (status === 401) message = 'Session expired. Sign in again to upload.';
  return new Error(message);
}

async function postJson(
  url: string,
  idToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Network error during upload.');
  }
  return { status: res.status, ok: res.ok, text: await res.text() };
}

/**
 * PUT the file bytes to a Drive resumable session URL. XHR is used instead
 * of fetch so the UI keeps its progress bar. The session URL is the
 * credential here, so no Authorization header is sent to Google.
 */
function putBytesToGoogle(
  uploadUrl: string,
  mimeType: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    if (mimeType) xhr.setRequestHeader('Content-Type', mimeType);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (typeof data?.id === 'string' && data.id.length > 0) resolve(data.id);
          else reject(new Error('Google Drive did not return a file reference. Try again.'));
        } catch {
          reject(new Error('Google Drive sent an unreadable response. Try again.'));
        }
        return;
      }
      let message = 'Google Drive refused the upload. Try again.';
      try {
        const data = JSON.parse(xhr.responseText);
        const detail = data?.error?.message;
        if (typeof detail === 'string' && detail.length > 0) message = detail;
      } catch {
        /* keep fallback */
      }
      reject(new Error(message));
    };

    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(file);
  });
}

/**
 * Upload a file through the Drive resumable flow.
 * Resolves with the stored file metadata; rejects with an Error whose
 * message is safe to show in the UI.
 */
export async function uploadToDrive(
  file: File,
  idToken: string,
  { kind, context, onProgress }: UploadOptions,
): Promise<DriveUploadMeta> {
  // 1. Ask our API to start a resumable session (validates kind, type, size).
  const initiated = await postJson('/api/uploads/initiate', idToken, {
    kind,
    fileName: file.name,
    sizeBytes: file.size,
    context,
  });
  if (!initiated.ok) {
    throw apiError(initiated.text, initiated.status, 'Upload failed');
  }
  let session: InitiateResult;
  try {
    session = JSON.parse(initiated.text);
  } catch {
    throw new Error('Invalid server response.');
  }
  if (!session?.uploadUrl) throw new Error('Invalid server response.');
  onProgress?.(3);

  // 2. Stream the bytes straight to Google, bypassing Vercel's body limit.
  const driveFileId = await putBytesToGoogle(session.uploadUrl, session.mimeType, file, (p) =>
    onProgress?.(3 + Math.round(p * 0.94)),
  );

  // 3. Let the server verify the file and build the metadata record.
  const done = await postJson('/api/uploads/complete', idToken, {
    kind,
    driveFileId,
    sizeBytes: file.size,
  });
  if (!done.ok) {
    throw apiError(done.text, done.status, 'Upload failed');
  }
  let data;
  try {
    data = JSON.parse(done.text);
  } catch {
    throw new Error('Invalid server response.');
  }
  onProgress?.(100);
  return {
    fileName: data.fileName,
    driveFileId: data.driveFileId,
    storagePath: data.storagePath,
    sizeBytes: data.sizeBytes ?? file.size,
    contentType: data.contentType || file.type,
    downloadUrl: data.downloadUrl || '',
    kind: data.kind || kind,
  };
}
