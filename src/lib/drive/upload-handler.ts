/**
 * Shared server-side upload handler for Drive-backed file uploads.
 *
 * Used by /api/uploads (general, kind-driven) and /api/sourcing/upload
 * (legacy CAD endpoint). Verifies the Firebase session, validates the file
 * against the kind's type/size rules, stores it in that kind's Drive folder,
 * and returns metadata for Firestore records.
 *
 * Server-only module: never import from client components.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySession, toSessionErrorResponse, SessionError } from '@/lib/auth/verifySession';
import { logUpload } from '@/lib/server/upload-logger';
import { uploadToVault } from './client';
import { UPLOAD_KINDS, UploadKind, extOfFile, getFolderId } from './folders';

export interface DriveFileMeta {
  fileName: string;
  driveFileId: string;
  storagePath: string;
  sizeBytes: number;
  contentType: string;
  downloadUrl: string;
}

/** Machine-readable upload failure codes so the client can tell errors apart. */
export type UploadErrorCode = 'too-big' | 'bad-type' | 'drive-error' | 'misconfigured' | 'auth';

/**
 * Structured error response for the upload API. Every failure carries a
 * plain-language message for the UI plus a code the client can branch on,
 * instead of collapsing to a generic "Upload failed".
 */
export function uploadError(message: string, code: UploadErrorCode, status: number): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

/** Map a session verification failure to a structured upload error. */
export function toUploadSessionError(err: unknown): NextResponse {
  if (err instanceof SessionError && err.statusCode !== 401) {
    return uploadError(
      'The server could not check your sign-in. Try again in a minute.',
      'misconfigured',
      500,
    );
  }
  return uploadError('Sign in to upload files.', 'auth', 401);
}

/**
 * Map a Drive-side failure to a structured upload error. A message naming a
 * GOOGLE_DRIVE_ env var means the server is misconfigured; anything else is
 * a Drive outage or API error.
 */
export function classifyDriveError(err: unknown, kind: UploadKind): NextResponse {
  const message = err instanceof Error ? err.message : 'Upload failed';
  console.error(`[uploads:${kind}] Drive error:`, message);
  if (message.includes('GOOGLE_DRIVE_')) {
    return uploadError(
      'Uploads are not set up on the server yet. Tell the site admin.',
      'misconfigured',
      500,
    );
  }
  return uploadError('Google Drive did not respond. Try again in a minute.', 'drive-error', 502);
}

export function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === 'string' && value in UPLOAD_KINDS;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Namespace a stored filename with the kind and caller-provided context.
 * Shared by the multipart path and the resumable initiate path so stored
 * names stay consistent.
 */
export function buildUniqueName(kind: UploadKind, fileName: string, context: string): string {
  const ctx = sanitize(String(context || 'general')).slice(0, 40) || 'general';
  return `${Date.now()}_${kind}_${ctx}_${sanitize(fileName)}`;
}

/**
 * Handle a multipart upload request. `fallbackKind` is used when the request
 * does not specify a kind (e.g. the legacy sourcing endpoint defaults to cad).
 */
export async function handleDriveUpload(
  request: NextRequest,
  fallbackKind: UploadKind = 'cad',
): Promise<NextResponse> {
  let sessionUid: string;
  try {
    const session = await verifySession(request);
    sessionUid = session.uid;
  } catch (err) {
    const mapped = toSessionErrorResponse(err);
    return mapped ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const rawKind = form.get('kind');
  const kind: UploadKind = isUploadKind(rawKind) ? rawKind : fallbackKind;
  const config = UPLOAD_KINDS[kind];

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  const ext = extOfFile(file.name);
  const mimeType = config.mimeByExt[ext];
  if (!mimeType) {
    return NextResponse.json(
      { error: `Unsupported file type. Accepted: ${Object.keys(config.mimeByExt).join(', ')}` },
      { status: 400 },
    );
  }

  const maxMb = Math.round(config.maxBytes / (1024 * 1024));
  if (file.size > config.maxBytes) {
    return NextResponse.json({ error: `File exceeds the ${maxMb}MB limit.` }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file.' }, { status: 400 });
  }

  // Namespace the filename with the kind and any caller-provided context.
  const uniqueName = buildUniqueName(kind, file.name, String(form.get('context') || 'general'));

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Could not read uploaded file.' }, { status: 400 });
  }

  try {
    const folderId = await getFolderId(kind);
    // Bug screenshots and site images must render in <img> tags, so they
    // get link-sharing plus a direct thumbnail URL. Receipts, CAD files and
    // documents keep the private webViewLink.
    const visual = kind === 'bug' || kind === 'image';
    const result = await uploadToVault(uniqueName, mimeType, buffer, folderId, {
      makePublic: visual,
    });
    const meta: DriveFileMeta = {
      fileName: result.fileName,
      driveFileId: result.fileId,
      storagePath: `drive-vault/${kind}/${result.fileId}`,
      sizeBytes: result.sizeBytes,
      contentType: result.mimeType,
      downloadUrl: visual ? result.thumbnailUrl : result.webViewLink,
    };
    // Fire-and-forget lifecycle log: never awaited, never throws, so a
    // logging failure cannot break the upload flow. This is what makes
    // multipart uploads visible in `upload_logs` even when the client never
    // attaches or submits the file.
    logUpload({
      status: 'completed',
      userId: sessionUid,
      fileName: result.fileName,
      uniqueName,
      kind,
      fileSizeBytes: result.sizeBytes,
      mimeType: result.mimeType,
      driveFileId: result.fileId,
      webViewLink: result.webViewLink,
    });
    return NextResponse.json({ success: true, kind, ...meta }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    const misconfigured = message.includes('GOOGLE_DRIVE_');
    console.error(`[uploads:${kind}] Drive upload failed:`, message);
    return NextResponse.json(
      { error: misconfigured ? 'Server misconfiguration' : 'Upload failed' },
      { status: misconfigured ? 500 : 502 },
    );
  }
}
