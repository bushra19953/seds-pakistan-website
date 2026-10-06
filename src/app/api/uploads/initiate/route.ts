/**
 * POST /api/uploads/initiate
 *
 * Starts a Drive resumable upload session so the browser can PUT file bytes
 * straight to Google. This bypasses Vercel's 4.5MB serverless request-body
 * limit, which the old multipart /api/uploads path could never survive for
 * large files (the edge returns 413 before the function runs).
 *
 * The client sends JSON {kind, fileName, sizeBytes, context?}. The server
 * validates it against UPLOAD_KINDS, resolves the destination folder, and
 * returns {uploadUrl, mimeType}. The client then PUTs the bytes to uploadUrl
 * and finishes with POST /api/uploads/complete.
 *
 * Requires a signed-in user (verifySession). Fails closed when Drive is
 * not configured. All failures return a structured {error, code} body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/verifySession';
import { getDriveAccessToken } from '@/lib/drive/client';
import { UPLOAD_KINDS, extOfFile, getFolderId } from '@/lib/drive/folders';
import {
  buildUniqueName,
  classifyDriveError,
  isUploadKind,
  toUploadSessionError,
  uploadError,
} from '@/lib/drive/upload-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESUMABLE_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

export async function POST(request: NextRequest) {
  try {
    await verifySession(request);
  } catch (err) {
    return toUploadSessionError(err);
  }

  let body: { kind?: unknown; fileName?: unknown; sizeBytes?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return uploadError('We could not read the upload request. Try again.', 'bad-type', 400);
  }

  const rawKind = body.kind;
  if (!isUploadKind(rawKind)) {
    return uploadError('Unknown upload type. Try again.', 'bad-type', 400);
  }
  const kind = rawKind;
  const config = UPLOAD_KINDS[kind];

  const fileName = typeof body.fileName === 'string' ? body.fileName : '';
  const mimeType = config.mimeByExt[extOfFile(fileName)];
  if (!mimeType) {
    return uploadError(
      `Unsupported file type. Accepted: ${Object.keys(config.mimeByExt).join(', ')}`,
      'bad-type',
      415,
    );
  }

  const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : NaN;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return uploadError('We could not read this file. Choose it again and retry.', 'bad-type', 400);
  }
  const maxMb = Math.round(config.maxBytes / (1024 * 1024));
  if (sizeBytes > config.maxBytes) {
    return uploadError(`This file is over the ${maxMb}MB limit.`, 'too-big', 413);
  }

  const context = typeof body.context === 'string' ? body.context : 'general';
  const uniqueName = buildUniqueName(kind, fileName, context);

  let folderId: string;
  try {
    folderId = await getFolderId(kind);
  } catch (err) {
    return classifyDriveError(err, kind);
  }

  try {
    const token = await getDriveAccessToken();
    const res = await fetch(RESUMABLE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(Math.floor(sizeBytes)),
      },
      body: JSON.stringify({ name: uniqueName, parents: [folderId], mimeType }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[uploads:${kind}] resumable session failed:`, res.status, detail.slice(0, 300));
      return uploadError(
        'Google Drive did not start the upload. Try again in a minute.',
        'drive-error',
        502,
      );
    }
    const uploadUrl = res.headers.get('location');
    if (!uploadUrl) {
      console.error(`[uploads:${kind}] resumable session missing Location header`);
      return uploadError(
        'Google Drive did not start the upload. Try again in a minute.',
        'drive-error',
        502,
      );
    }
    return NextResponse.json({ uploadUrl, mimeType, uniqueName }, { status: 200 });
  } catch (err) {
    return classifyDriveError(err, kind);
  }
}
