/**
 * Google Drive folder management for SEDS website uploads.
 *
 * Every upload kind gets its own top-level folder in the site owner's Drive
 * so files stay easy to manage:
 *   - cad      -> "SEDS CAD Vault" (existing)
 *   - image    -> "SEDS Website Images"
 *   - bug      -> "SEDS Bug Reports"
 *   - document -> "SEDS Chapter Documents"
 *   - receipt  -> "SEDS Payment Receipts"
 *
 * A folder ID can be pinned with an env var (GOOGLE_DRIVE_<KIND>_FOLDER_ID);
 * otherwise the folder is found by name or created on first use, then cached
 * in memory for the lifetime of the server process.
 *
 * Server-only module: never import from client components.
 */

import { getDriveClient } from './client';

export type UploadKind = 'cad' | 'image' | 'bug' | 'document' | 'receipt';

interface KindConfig {
  folderName: string;
  envVar: string;
  maxBytes: number;
  /** Allowed extensions (lowercase, with dot) mapped to MIME types. */
  mimeByExt: Record<string, string>;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const UPLOAD_KINDS: Record<UploadKind, KindConfig> = {
  cad: {
    folderName: 'SEDS CAD Vault',
    envVar: 'GOOGLE_DRIVE_VAULT_FOLDER_ID',
    maxBytes: 100 * 1024 * 1024,
    mimeByExt: {
      '.step': 'model/step',
      '.stp': 'model/step',
      '.stl': 'model/stl',
      '.zip': 'application/zip',
      '.pdf': 'application/pdf',
    },
  },
  image: {
    folderName: 'SEDS Website Images',
    envVar: 'GOOGLE_DRIVE_IMAGES_FOLDER_ID',
    maxBytes: 10 * 1024 * 1024,
    mimeByExt: IMAGE_MIME,
  },
  bug: {
    folderName: 'SEDS Bug Reports',
    envVar: 'GOOGLE_DRIVE_BUG_REPORTS_FOLDER_ID',
    maxBytes: 10 * 1024 * 1024,
    mimeByExt: IMAGE_MIME,
  },
  document: {
    folderName: 'SEDS Chapter Documents',
    envVar: 'GOOGLE_DRIVE_DOCUMENTS_FOLDER_ID',
    maxBytes: 25 * 1024 * 1024,
    mimeByExt: {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ...IMAGE_MIME,
    },
  },
  receipt: {
    folderName: 'SEDS Payment Receipts',
    envVar: 'GOOGLE_DRIVE_RECEIPTS_FOLDER_ID',
    maxBytes: 10 * 1024 * 1024,
    mimeByExt: {
      ...IMAGE_MIME,
      '.pdf': 'application/pdf',
    },
  },
};

const folderIdCache = new Map<UploadKind, string>();

/** Resolve the Drive folder ID for an upload kind (env var, cache, or find-or-create). */
export async function getFolderId(kind: UploadKind): Promise<string> {
  const config = UPLOAD_KINDS[kind];
  if (!config) throw new Error(`Unknown upload kind: ${kind}`);

  const fromEnv = process.env[config.envVar];
  if (fromEnv) return fromEnv;

  const cached = folderIdCache.get(kind);
  if (cached) return cached;

  const drive = getDriveClient();

  // Find an existing folder with this exact name (only app-created ones are visible).
  const found = await drive.files.list({
    q: `name = '${config.folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 5,
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) {
    folderIdCache.set(kind, existing);
    return existing;
  }

  // Create it at the top level of My Drive.
  const created = await drive.files.create({
    requestBody: {
      name: config.folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  const folderId = created.data.id;
  if (!folderId) throw new Error(`Could not create Drive folder "${config.folderName}"`);
  folderIdCache.set(kind, folderId);
  return folderId;
}

export function extOfFile(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}
