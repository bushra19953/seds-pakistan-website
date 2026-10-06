/**
 * Client-side helper for Drive-backed uploads.
 *
 * Uses a resumable flow so large files bypass Vercel's 4.5MB serverless
 * request-body limit (the edge returns 413 before the function ever runs):
 *   1. POST /api/uploads/initiate (JSON) -> {uploadUrl, mimeType, uniqueName}
 *   2. PUT the raw file bytes straight to Google (XHR, for progress)
 *   3. POST /api/uploads/complete {kind, uniqueName, driveFileId?, sizeBytes?}
 *      -> DriveUploadMeta
 *
 * Drive's resumable PUT responses are not CORS-readable, so step 2 often
 * fires onerror after transmitting 100% of the bytes. When that happens the
 * client does NOT hard-fail: it proceeds to step 3 with {kind, uniqueName}
 * and no driveFileId, and the server confirms the file by name lookup.
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
  /** Fires true while the completion call is in flight, false when it ends. */
  onConfirming?: (confirming: boolean) => void;
}

interface InitiateResult {
  uploadUrl: string;
  mimeType: string;
  /** Server-assigned unique filename; the server uses it to find the file. */
  uniqueName: string;
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
 *
 * Drive's resumable-upload PUT responses are not CORS-readable, so the
 * browser fires onerror after transmitting 100% of the bytes even though
 * the file landed in Drive. This must be told apart from a PUT that never
 * sent anything:
 *   (a) PUT never sent: onerror fires with upload.loaded far below
 *       upload.total, or open()/send() threw. Hard fail with the error.
 *   (b) Bytes all transmitted but the response is unreadable (status 0 or
 *       onerror with upload.loaded within a few percent of upload.total).
 *       Resolve null: the caller then asks the server to confirm the file
 *       by uniqueName instead of failing.
 */
function putBytesToGoogle(
  uploadUrl: string,
  mimeType: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let sentBytes = 0;
    let totalBytes = 0;

    /** True when effectively every byte was transmitted (within 3%). */
    const allBytesSent = () => totalBytes > 0 && sentBytes >= totalBytes * 0.97;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        sentBytes = e.loaded;
        totalBytes = e.total;
        onProgress?.(Math.round((e.loaded / e.total) * 100));
      }
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
      // Readable status, but the bytes never made it out. Hard fail.
      if (!allBytesSent()) {
        let message = 'Google Drive refused the upload. Try again.';
        try {
          const data = JSON.parse(xhr.responseText);
          const detail = data?.error?.message;
          if (typeof detail === 'string' && detail.length > 0) message = detail;
        } catch {
          /* keep fallback */
        }
        reject(new Error(message));
        return;
      }
      // All bytes transmitted, but the response could not be read
      // (e.g. CORS-blocked status 0). Hand off to server-side confirmation.
      resolve(null);
    };

    xhr.onerror = () => {
      // This fires both for a genuinely dead connection and for a
      // successful send whose response is not CORS-readable. If the bytes
      // all went out, the server confirms by name; otherwise hard fail.
      if (allBytesSent()) {
        resolve(null);
        return;
      }
      reject(new Error('Network error during upload.'));
    };

    try {
      xhr.open('PUT', uploadUrl);
      if (mimeType) xhr.setRequestHeader('Content-Type', mimeType);
      xhr.send(file);
    } catch {
      reject(new Error('Network error during upload.'));
    }
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
  { kind, context, onProgress, onConfirming }: UploadOptions,
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
  if (typeof session?.uniqueName !== 'string' || session.uniqueName.length === 0) {
    throw new Error('Invalid server response.');
  }
  const uniqueName: string = session.uniqueName;
  onProgress?.(3);

  // 2. Stream the bytes straight to Google, bypassing Vercel's body limit.
  //    A null file id means the bytes were transmitted but Drive's response
  //    was not CORS-readable; the completion call then confirms by name.
  const driveFileId = await putBytesToGoogle(session.uploadUrl, session.mimeType, file, (p) =>
    onProgress?.(3 + Math.round(p * 0.94)),
  );

  // 3. Let the server verify the file and build the metadata record.
  onConfirming?.(true);
  let done;
  try {
    done = await postJson('/api/uploads/complete', idToken, {
      kind,
      uniqueName,
      ...(driveFileId ? { driveFileId } : {}),
      sizeBytes: file.size,
    });
  } finally {
    onConfirming?.(false);
  }
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
