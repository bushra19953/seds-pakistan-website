/**
 * POST /api/uploads/complete
 *
 * Finishes a resumable upload started by /api/uploads/initiate. The browser
 * already PUT the file bytes straight to Google; this endpoint verifies the
 * file landed in the right Drive folder, enables link-sharing for visual
 * kinds (bug/image, same as the old multipart path), and returns the file
 * metadata the UI stores with the submission.
 *
 * Requires a signed-in user (verifySession). All failures return a
 * structured {error, code} body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySession } from '@/lib/auth/verifySession';
import { getDriveClient } from '@/lib/drive/client';
import { getFolderId } from '@/lib/drive/folders';
import {
  classifyDriveError,
  isUploadKind,
  toUploadSessionError,
  uploadError,
} from '@/lib/drive/upload-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    await verifySession(request);
  } catch (err) {
    return toUploadSessionError(err);
  }

  let body: { kind?: unknown; driveFileId?: unknown; sizeBytes?: unknown };
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
  const driveFileId = typeof body.driveFileId === 'string' ? body.driveFileId : '';
  if (!driveFileId) {
    return uploadError('Google did not return a file reference. Upload again.', 'bad-type', 400);
  }
  const clientSize = typeof body.sizeBytes === 'number' && body.sizeBytes > 0 ? body.sizeBytes : 0;

  let folderId: string;
  try {
    folderId = await getFolderId(kind);
  } catch (err) {
    return classifyDriveError(err, kind);
  }

  const drive = getDriveClient();
  let file: {
    id?: string | null;
    name?: string | null;
    size?: string | null;
    mimeType?: string | null;
    webViewLink?: string | null;
    parents?: string[] | null;
  };
  try {
    const res = await drive.files.get({
      fileId: driveFileId,
      fields: 'id, name, size, mimeType, webViewLink, parents',
      supportsAllDrives: true,
    });
    file = res.data;
  } catch (err) {
    return classifyDriveError(err, kind);
  }

  if (!file?.id) {
    return uploadError(
      'We could not find your file on Google Drive. Upload again.',
      'drive-error',
      502,
    );
  }
  // The session metadata fixed the parent folder at initiation time, so this
  // should always hold. It is checked anyway as defense in depth.
  if (!file.parents?.includes(folderId)) {
    console.error(`[uploads:${kind}] file ${driveFileId} landed outside the expected folder`);
    return uploadError(
      'Your file did not land in the right Drive folder. Upload again.',
      'drive-error',
      502,
    );
  }

  // Bug screenshots and site images must render in <img> tags, so they get
  // link-sharing plus a direct thumbnail URL, same as the old upload path.
  const visual = kind === 'bug' || kind === 'image';
  if (visual) {
    try {
      await drive.permissions.create({
        fileId: driveFileId,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
    } catch (err) {
      return classifyDriveError(err, kind);
    }
  }

  return NextResponse.json(
    {
      success: true,
      kind,
      fileName: file.name || '',
      driveFileId: file.id,
      storagePath: `drive-vault/${kind}/${file.id}`,
      sizeBytes: Number(file.size || clientSize || 0),
      contentType: file.mimeType || '',
      downloadUrl: visual
        ? `https://lh3.googleusercontent.com/d/${file.id}=w1600`
        : file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    },
    { status: 201 },
  );
}
