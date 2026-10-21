/**
 * Drive filing for generated appointment letters (spec G.4.1 step 5,
 * G.5.4). The generated PDF is archived under the 'governance' kind;
 * the live download route regenerates from the snapshot, so a filing
 * failure never un-issues a letter: the caller records the failure and
 * the instrument keeps null Drive fields with a retry affordance.
 */

import { Readable } from 'stream';
import { getDriveClient } from '@/lib/drive/client';
import { getFolderId } from '@/lib/drive/folders';

export interface FiledLetter {
  driveFileId: string;
  driveWebViewLink: string | null;
  sizeBytes: number;
}

export async function fileLetterPdfToDrive(
  fileName: string,
  buffer: Buffer,
): Promise<FiledLetter> {
  const drive = getDriveClient();
  const folderId = await getFolderId('governance');
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
    fields: 'id, webViewLink, size',
  });
  const id = res.data.id;
  if (!id) throw new Error('Drive filing returned no file id.');
  return {
    driveFileId: id,
    driveWebViewLink: res.data.webViewLink ?? null,
    sizeBytes: buffer.length,
  };
}
