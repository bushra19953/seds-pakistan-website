/**
 * Server-side hash of an uploaded acceptance file (spec G.4.2 step 2).
 *
 * The hash is computed from the file BYTES read back from Drive by the
 * server. A client-supplied hash is never trusted (the acceptance
 * route ignores any fileHash in the request body entirely).
 *
 * ADAPTER: reads via the Drive v3 client (files.get, alt=media). If
 * the Part D records store later exposes a server read path for filed
 * records, this is the one function to swap.
 */

import { createHash } from 'crypto';
import { getDriveClient } from '@/lib/drive/client';

export async function computeDriveFileHash(driveFileId: string): Promise<string> {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId: driveFileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  const data = res.data as ArrayBuffer | Buffer;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  return createHash('sha256').update(buf).digest('hex');
}
