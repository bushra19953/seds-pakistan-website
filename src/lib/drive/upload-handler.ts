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
import { verifySession, toSessionErrorResponse } from '@/lib/auth/verifySession';
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

function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === 'string' && value in UPLOAD_KINDS;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Handle a multipart upload request. `fallbackKind` is used when the request
 * does not specify a kind (e.g. the legacy sourcing endpoint defaults to cad).
 */
export async function handleDriveUpload(
  request: NextRequest,
  fallbackKind: UploadKind = 'cad',
): Promise<NextResponse> {
  try {
    await verifySession(request);
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
  const context = sanitize(String(form.get('context') || 'general')).slice(0, 40) || 'general';
  const uniqueName = `${Date.now()}_${kind}_${context}_${sanitize(file.name)}`;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Could not read uploaded file.' }, { status: 400 });
  }

  try {
    const folderId = await getFolderId(kind);
    const result = await uploadToVault(uniqueName, mimeType, buffer, folderId);
    const meta: DriveFileMeta = {
      fileName: result.fileName,
      driveFileId: result.fileId,
      storagePath: `drive-vault/${kind}/${result.fileId}`,
      sizeBytes: result.sizeBytes,
      contentType: result.mimeType,
      downloadUrl: result.webViewLink,
    };
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
