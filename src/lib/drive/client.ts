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

/**
 * Mint a short-lived OAuth2 access token for raw Google API calls, such as
 * starting a resumable upload session. Server-only: the token never goes to
 * the browser. Clients PUT to the single-use session URL instead.
 */
export async function getDriveAccessToken(): Promise<string> {
  const client = getOAuthClient();
  const res = await client.getAccessToken();
  const token = typeof res === 'string' ? res : res?.token;
  if (!token) {
    throw new Error(
      'GOOGLE_DRIVE_ access token could not be minted; check CLIENT_ID, CLIENT_SECRET and REFRESH_TOKEN',
    );
  }
  return token;
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
    // Use lh3.googleusercontent.com form: serves CORS headers (Access-Control-Allow-Origin: *)
    // so WebGL texture loads (three.js) and fetch() work. The drive.google.com/thumbnail
    // form 302-redirects without CORS headers, breaking CORS-mode requests.
    thumbnailUrl: `https://lh3.googleusercontent.com/d/${data.id}=w1600`,
  };
}

/**
 * Convert a drive.google.com/thumbnail URL to the CORS-safe lh3.googleusercontent.com form.
 * The lh3 form serves Access-Control-Allow-Origin: * so it works in WebGL textures,
 * fetch(), and other CORS-mode contexts where the thumbnail form fails.
 */
export function driveThumbnailToDirect(url: string): string {
  const m = url.match(/drive\.google\.com\/thumbnail\?id=([^&]+)(?:&sz=w(\d+))?/);
  if (m) {
    const width = m[2] || '1600';
    return `https://lh3.googleusercontent.com/d/${m[1]}=w${width}`;
  }
  return url;
}
