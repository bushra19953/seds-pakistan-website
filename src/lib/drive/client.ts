/**
 * Server-side Google Drive client for the SEDS CAD vault.
 *
 * Uses OAuth2 as the site owner's Google account (refresh token stored in
 * GOOGLE_DRIVE_REFRESH_TOKEN), so uploads land in the owner's Drive with the
 * owner's storage quota. This is the zero-cost replacement for Firebase
 * Storage uploads, which require a paid Blaze plan.
 *
 * Server-only module: never import from client components.
 * Credentials never leave the server; clients upload through /api/sourcing/upload.
 */

import { google } from 'googleapis';
import { Readable } from 'stream';

let oauthClient: InstanceType<typeof google.auth.OAuth2> | null = null;

function getOAuthClient(): InstanceType<typeof google.auth.OAuth2> {
  if (oauthClient) return oauthClient;

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN are not all configured',
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  oauthClient = client;
  return client;
}

export function getDriveClient() {
  return google.drive({ version: 'v3', auth: getOAuthClient() });
}

export function getVaultFolderId(): string {
  const folderId = process.env.GOOGLE_DRIVE_VAULT_FOLDER_ID;
  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_VAULT_FOLDER_ID is not configured');
  }
  return folderId;
}

export interface DriveUploadResult {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  webViewLink: string;
  thumbnailUrl: string;
}

/**
 * Upload a file buffer into a Drive folder.
 * Returns Drive file metadata for storing in Firestore.
 */
export async function uploadToVault(
  fileName: string,
  mimeType: string,
  buffer: Buffer,
  folderId?: string,
  opts?: { makePublic?: boolean },
): Promise<DriveUploadResult> {
  const drive = getDriveClient();
  const parentId = folderId || getVaultFolderId();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
      mimeType,
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id, name, size, mimeType, webViewLink',
    supportsAllDrives: true,
  });

  const data = res.data;
  if (!data.id) {
    throw new Error('Drive upload did not return a file ID');
  }

  // Files that must render directly in <img> tags (bug screenshots, site
  // images) need link-sharing on, otherwise Drive returns 403 for viewers.
  if (opts?.makePublic) {
    await drive.permissions.create({
      fileId: data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  }

  return {
    fileId: data.id,
    fileName: data.name || fileName,
    sizeBytes: Number(data.size || buffer.length),
    mimeType: data.mimeType || mimeType,
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    // Direct image bytes for <img> rendering. webViewLink is a preview page
    // and cannot be used as an image src.
    thumbnailUrl: `https://drive.google.com/thumbnail?id=${data.id}&sz=w1600`,
  };
}
