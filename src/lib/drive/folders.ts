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
 *   - video    -> "SEDS Video Deliverables"
 *   - governance -> "SEDS Governance Records" (Phase 3 Workstream G;
 *     ADAPTER: Part D's records store defines the same 'governance'
 *     kind in its own worktree - dedupe to one definition at merge)
 *
 * A folder ID can be pinned with an env var (GOOGLE_DRIVE_<KIND>_FOLDER_ID);
 * otherwise the folder is found by name or created on first use, then cached
 * in memory for the lifetime of the server process.
 *
 * Exception: task proofs (document/video uploads with a `task-<id>`
 * context) go to a per-person folder under "SEDS Proof Submissions"
 * instead of the shared document/video folders — see the per-person proof
 * folders section at the bottom of this file.
 *
 * Server-only module: never import from client components.
 */

import { getDriveClient } from './client';
import { admin, getDb } from '@/lib/server/firebase-admin';

export type UploadKind = 'cad' | 'image' | 'bug' | 'document' | 'receipt' | 'video' | 'governance';

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
  // Governance records (Phase 3 Workstream B/D): candidate consent
  // forms, signed election certificates, tie-by-lot evidence, AGM
  // notice PDFs, audited accounts. 25 MB cap, document MIME set,
  // mirroring the document kind. NEVER public: the upload handler only
  // link-shares bug/image kinds, and governance files are served back
  // exclusively through gated API routes.
  governance: {
    folderName: 'SEDS Governance Records',
    envVar: 'GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID',
    maxBytes: 25 * 1024 * 1024,
    mimeByExt: {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ...IMAGE_MIME,
    },
  },
  // Video deliverables (e.g. the 30-45s social teaser): 100MB, matching the
  // CAD precedent. The binding constraint is RAM, not bandwidth: the handler
  // buffers the whole file in memory (Buffer.from(await file.arrayBuffer()))
  // before streaming it to Drive, so a larger limit risks OOM on a
  // serverless function. 100MB covers a 30-45s 1080p phone video (typically
  // 30-150MB, and most phones encode 45s at 1080p30 well under 100MB).
  video: {
    folderName: 'SEDS Video Deliverables',
    envVar: 'GOOGLE_DRIVE_VIDEOS_FOLDER_ID',
    maxBytes: 100 * 1024 * 1024,
    mimeByExt: {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.m4v': 'video/x-m4v',
      // Zip archives are accepted as a fallback container for video work
      // (e.g. when the raw video will not upload). Stored to Drive as-is;
      // the server never extracts them.
      '.zip': 'application/zip',
    },
  },
  // Governance records (appointment letters, signed acceptances,
  // decision extracts): 25 MB, the document kind's mime map (G.5.4).
  governance: {
    folderName: 'SEDS Governance Records',
    envVar: 'GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID',
    maxBytes: 25 * 1024 * 1024,
    mimeByExt: {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      ...IMAGE_MIME,
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

// ---------------------------------------------------------------------------
// Per-person proof folders
//
// Task proof files (kinds document/video sent with a `task-<id>` context)
// do NOT go to the shared kind folders above: every member's proofs share
// one folder there, so nothing can be browsed or found by person. Instead
// each uploader gets a personal folder under a single root:
//
//   SEDS Proof Submissions/
//     <display-slug>-<uid>/
//       2026-11-01_<display-slug>_<taskId>_document_<original name>
//
// The uid is embedded in the folder name because display names collide.
// The durable uid -> folderId mapping lives in Firestore
// (`drive_person_folders/<uid>`, server-only via the Admin SDK, so no
// client security rule is involved) because env vars cannot scale to one
// folder per person. Resolution is deterministic from the uid alone, which
// is what lets /api/uploads/complete re-derive the exact folder initiate
// used. Person folders are never shared at folder level; file-level
// sharing behaviour is unchanged.
// ---------------------------------------------------------------------------

export const PROOF_SUBMISSIONS_ROOT_NAME = 'SEDS Proof Submissions';
const PERSON_FOLDER_MAP_COLLECTION = 'drive_person_folders';

let proofRootFolderIdCache: string | null = null;
const personFolderIdCache = new Map<string, string>();
const personSlugCache = new Map<string, string>();

/** Find a folder by exact name, optionally scoped to a parent folder. */
async function findFolderIdByName(name: string, parentId?: string): Promise<string | null> {
  const drive = getDriveClient();
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const found = await drive.files.list({
    q: `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`,
    fields: 'files(id, name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return found.data.files?.[0]?.id ?? null;
}

/** Create a folder, optionally under a parent folder. */
async function createDriveFolder(name: string, parentId?: string): Promise<string> {
  const drive = getDriveClient();
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  });
  const folderId = created.data.id;
  if (!folderId) throw new Error(`Could not create Drive folder "${name}"`);
  return folderId;
}

/** Resolve the shared "SEDS Proof Submissions" root folder (env pin, cache, or find-or-create). */
export async function getProofRootFolderId(): Promise<string> {
  const fromEnv = process.env.GOOGLE_DRIVE_PROOF_SUBMISSIONS_FOLDER_ID;
  if (fromEnv) return fromEnv;

  if (proofRootFolderIdCache) return proofRootFolderIdCache;

  const existing = await findFolderIdByName(PROOF_SUBMISSIONS_ROOT_NAME);
  const folderId = existing ?? (await createDriveFolder(PROOF_SUBMISSIONS_ROOT_NAME));
  proofRootFolderIdCache = folderId;
  return folderId;
}

/** URL/filename-safe slug for a person's display name ('member' when nothing usable). */
export function slugifyPersonName(value: string): string {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'member';
}

/**
 * The person's slug, derived server-side from their users doc
 * (displayName, then name, then the email local part). Never taken from
 * client input: the client controls the upload context string, so a
 * client-sent name could file one person's proof under another's folder.
 */
export async function getPersonSlug(uid: string): Promise<string> {
  const cached = personSlugCache.get(uid);
  if (cached) return cached;

  const db = getDb();
  if (!db) throw new Error('Person folder resolution needs Firestore, which is unavailable');
  const snap = await db.collection('users').doc(uid).get();
  const data = (snap.exists ? snap.data() : undefined) as Record<string, unknown> | undefined;
  const raw =
    typeof data?.displayName === 'string' && data.displayName
      ? data.displayName
      : typeof data?.name === 'string' && data.name
        ? data.name
        : typeof data?.email === 'string' && data.email
          ? data.email.split('@')[0]
          : '';
  const slug = slugifyPersonName(raw);
  personSlugCache.set(uid, slug);
  return slug;
}

export interface PersonFolder {
  folderId: string;
  slug: string;
  folderName: string;
}

function isAlreadyExistsError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  return (
    e.code === 6 ||
    e.code === 'already-exists' ||
    (typeof e.message === 'string' && /already exists/i.test(e.message))
  );
}

/**
 * Resolve (creating on first use) the Drive folder holding one person's
 * task proofs. Deterministic from the uid: the Firestore mapping is the
 * source of truth, so initiate and complete always agree.
 *
 * First-use race: two concurrent first uploads can both miss the mapping
 * and both create a folder. The mapping write uses create(), which is
 * atomic, so exactly one claim wins and the loser adopts the winner's
 * folderId (its own just-created folder stays empty and orphaned; the
 * upload that raced it may need one retry, after which the mapping makes
 * every later resolution land in the winner's folder).
 */
export async function resolvePersonFolder(uid: string): Promise<PersonFolder> {
  const slug = await getPersonSlug(uid);
  const folderName = `${slug}-${uid}`;

  const cached = personFolderIdCache.get(uid);
  if (cached) return { folderId: cached, slug, folderName };

  const db = getDb();
  if (!db) throw new Error('Person folder resolution needs Firestore, which is unavailable');
  const mapRef = db.collection(PERSON_FOLDER_MAP_COLLECTION).doc(uid);
  const mapSnap = await mapRef.get();
  const mapped = mapSnap.exists ? (mapSnap.data()?.folderId as unknown) : undefined;
  if (typeof mapped === 'string' && mapped) {
    personFolderIdCache.set(uid, mapped);
    return { folderId: mapped, slug, folderName };
  }

  const rootId = await getProofRootFolderId();
  // Adopt a folder an earlier crashed attempt already created under the
  // root before making a second one; the name embeds the uid, so an exact
  // name match under the root can only be this person's folder.
  let folderId =
    (await findFolderIdByName(folderName, rootId)) ??
    (await createDriveFolder(folderName, rootId));

  try {
    await mapRef.create({
      folderId,
      slug,
      folderName,
      rootFolderId: rootId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    const winner = await mapRef.get();
    const winnerId = winner.data()?.folderId as unknown;
    if (typeof winnerId === 'string' && winnerId) folderId = winnerId;
  }

  personFolderIdCache.set(uid, folderId);
  return { folderId, slug, folderName };
}

/** Resolve only the folder ID for a person's task proofs. */
export async function getPersonFolderId(uid: string): Promise<string> {
  return (await resolvePersonFolder(uid)).folderId;
}

/**
 * True when an upload is a task proof: a document or video sent with a
 * `task-<taskId>` context (the context every task upload UI sends). Only
 * these route to person folders; all other uploads keep the kind folders.
 */
export function isTaskProofUpload(kind: UploadKind, context: unknown): boolean {
  return (
    (kind === 'document' || kind === 'video') &&
    typeof context === 'string' &&
    context.startsWith('task-')
  );
}
