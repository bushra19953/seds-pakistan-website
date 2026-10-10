/**
 * POST /api/uploads/complete
 *
 * Finishes a resumable upload started by /api/uploads/initiate. The browser
 * already PUT the file bytes straight to Google; this endpoint verifies the
 * file landed in the right Drive folder, enables link-sharing for visual
 * kinds (bug/image, same as the old multipart path), and returns the file
 * metadata the UI stores with the submission.
 *
 * Two ways to identify the file, sent as JSON {kind, driveFileId?, uniqueName?, sizeBytes?}:
 * - driveFileId present: the normal path. The file is fetched directly and
 *   its parents are checked to prove it sits in the kind's folder (never
 *   trust a client-provided fileId without that check).
 * - driveFileId absent: the browser's resumable PUT could not read Google's
 *   CORS-blocked response, so it has no fileId. The server then looks the
 *   file up by the uniqueName the initiate endpoint returned, retrying a few
 *   times because Drive needs a moment to finalize after the PUT.
 *
 * The body may also carry an optional taskId, but attachment is handled by the
 * client through POST /api/tasks/attach-upload (the uploader components call
 * it right after a successful upload). Every completed upload is recorded in
 * the `upload_logs` collection here, so files are tracked server-side even
 * when the user never attaches or submits them.
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
import type { UploadKind } from '@/lib/drive/folders';
import { markUploadCompleted } from '@/lib/server/upload-logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOOKUP_RETRIES = 4;
const LOOKUP_RETRY_MS = 2500;

type DriveFileMeta = {
  id?: string | null;
  name?: string | null;
  size?: string | null;
  mimeType?: string | null;
  webViewLink?: string | null;
  parents?: string[] | null;
};

/** Enable link-sharing on bug/image files so they render in <img> tags. */
async function enableLinkSharing(driveFileId: string) {
  const drive = getDriveClient();
  await drive.permissions.create({
    fileId: driveFileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });
}

/**
 * Build the identical file metadata response the client stores with the
 * submission, shared by both verification paths (by fileId and by name
 * lookup).
 */
function buildFileMetadata(
  kind: UploadKind,
  file: DriveFileMeta,
  clientSize: number,
  userId: string,
): NextResponse {
  const driveFileId = file.id as string;
  // Record the completed upload server-side (fire-and-forget, never throws)
  // so the file is tracked in `upload_logs` even if the user never attaches
  // it to a task or submits. `file.name` is the uniqueName the initiate
  // endpoint assigned, which lets markUploadCompleted match the 'initiated'
  // log written earlier.
  void markUploadCompleted(file.name || '', {
    userId,
    kind,
    driveFileId,
    fileSizeBytes: Number(file.size || clientSize || 0),
    webViewLink: file.webViewLink ?? null,
  });
  // Bug screenshots and site images must render in <img> tags, so they get
  // a direct thumbnail URL, same as the old upload path.
  const visual = kind === 'bug' || kind === 'image';
  return NextResponse.json(
    {
      success: true,
      kind,
      fileName: file.name || '',
      driveFileId,
      storagePath: `drive-vault/${kind}/${driveFileId}`,
      sizeBytes: Number(file.size || clientSize || 0),
      contentType: file.mimeType || '',
      downloadUrl: visual
        ? `https://lh3.googleusercontent.com/d/${driveFileId}=w1600`
        : file.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`,
    },
    { status: 201 },
  );
}

/**
 * Look up a file by its stored name inside the kind's folder. Retries because
 * Drive needs a moment to finalize a file after the resumable PUT completes.
 * Returns the first match or null.
 */
async function findFileByName(
  folderId: string,
  uniqueName: string,
): Promise<DriveFileMeta | null> {
  const drive = getDriveClient();
  // uniqueName contains Date.now() plus a sanitized kind/context/file name,
  // so name collisions are practically impossible: at most one file matches.
  const q = `name='${uniqueName}' and '${folderId}' in parents and trashed=false`;
  for (let attempt = 1; attempt <= LOOKUP_RETRIES; attempt++) {
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, size, mimeType, webViewLink, parents)',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const file = res.data.files?.[0] ?? null;
    if (file?.id) {
      return file;
    }
    if (attempt < LOOKUP_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, LOOKUP_RETRY_MS));
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  let userId: string;
  try {
    const session = await verifySession(request);
    userId = session.uid;
  } catch (err) {
    return toUploadSessionError(err);
  }

  let body: { kind?: unknown; driveFileId?: unknown; uniqueName?: unknown; sizeBytes?: unknown };
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
  const clientSize = typeof body.sizeBytes === 'number' && body.sizeBytes > 0 ? body.sizeBytes : 0;

  let folderId: string;
  try {
    folderId = await getFolderId(kind);
  } catch (err) {
    return classifyDriveError(err, kind);
  }

  const driveFileId = typeof body.driveFileId === 'string' ? body.driveFileId : '';
  if (!driveFileId) {
    return completeByNameLookup(kind, folderId, body.uniqueName, clientSize, userId);
  }

  const drive = getDriveClient();
  let file: DriveFileMeta;
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

  const visual = kind === 'bug' || kind === 'image';
  if (visual) {
    try {
      await enableLinkSharing(driveFileId);
    } catch (err) {
      return classifyDriveError(err, kind);
    }
  }

  return buildFileMetadata(kind, file, clientSize, userId);
}

async function completeByNameLookup(
  kind: UploadKind,
  folderId: string,
  rawUniqueName: unknown,
  clientSize: number,
  userId: string,
): Promise<NextResponse> {
  const uniqueName = typeof rawUniqueName === 'string' ? rawUniqueName : '';
  if (!uniqueName) {
    return uploadError('Google did not return a file reference. Upload again.', 'bad-type', 400);
  }

  let lookup: DriveFileMeta | null;
  try {
    lookup = await findFileByName(folderId, uniqueName);
  } catch (err) {
    return classifyDriveError(err, kind);
  }
  if (!lookup) {
    console.error(`[uploads:${kind}] name lookup failed for ${uniqueName} after retries`);
    return uploadError(
      'We could not confirm your upload landed. Please try again.',
      'drive-error',
      502,
    );
  }

  const driveFileId = lookup.id as string;
  if (!lookup.parents?.includes(folderId)) {
    console.error(`[uploads:${kind}] file ${driveFileId} landed outside the expected folder`);
    return uploadError(
      'Your file did not land in the right Drive folder. Upload again.',
      'drive-error',
      502,
    );
  }

  const visual = kind === 'bug' || kind === 'image';
  if (visual) {
    try {
      await enableLinkSharing(driveFileId);
    } catch (err) {
      return classifyDriveError(err, kind);
    }
  }

  return buildFileMetadata(kind, lookup, clientSize, userId);
}
