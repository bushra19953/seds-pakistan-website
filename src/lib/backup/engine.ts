/**
 * Server-side scheduled backup engine (Workstream F, spec ws-f.md 1.1 item 1).
 *
 * Exports every collection in the backup registry to Google Drive as one
 * JSON file per collection plus a manifest.json, and writes a backup_runs
 * run record. Backups land in a separate "SEDS Backups" Drive folder
 * (phase3_spec.md 0.4 item 3): never the governance folder, never
 * public-shared (makePublic is always false).
 *
 * One collection failing does not abort the run: the failure is recorded
 * in `errors` and the run finishes 'partial'. A run is 'failed' only when
 * the manifest upload or the run record write cannot be completed.
 * On 'partial' / 'failed' an audit_logs entry is written best-effort.
 *
 * Idempotency: runIds are unique per invocation, collection files are
 * named with the runId prefix, and the run record is written with set()
 * semantics by the default factory, so a retry with the same runId
 * overwrites rather than duplicates.
 *
 * Server-only module: never import from client components.
 */

import { createHash, randomUUID } from 'crypto';
import { getDb } from '@/lib/server/firebase-admin';
import { getDriveClient, uploadToVault } from '@/lib/drive/client';
import {
  BACKUP_COLLECTIONS,
  collectionsForBackup,
  type BackupCollectionEntry,
} from './registry';

export const BACKUP_FOLDER_NAME = 'SEDS Backups';
export const BACKUP_FOLDER_ENV_VAR = 'GOOGLE_DRIVE_BACKUP_FOLDER_ID';

// --- Injectable dependency surface (tests mock these) ---

export interface BackupDocSnapshot {
  id: string;
  data: () => unknown;
}

export interface BackupDb {
  collection: (name: string) => {
    get: () => Promise<{ docs: BackupDocSnapshot[] }>;
  };
}

export interface UploadToDriveArgs {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  folderId?: string;
  makePublic: boolean;
}

export interface UploadToDriveResult {
  fileId: string;
  webViewLink?: string;
}

export type UploadToDriveFn = (
  args: UploadToDriveArgs,
) => Promise<UploadToDriveResult>;

export type WriteRunRecordFn = (
  runId: string,
  record: BackupRunRecord,
) => Promise<void>;

export type WriteAuditFn = (entry: Record<string, unknown>) => Promise<void>;

export interface BackupDeps {
  db: BackupDb;
  uploadToDrive: UploadToDriveFn;
  writeRunRecord: WriteRunRecordFn;
  writeAudit: WriteAuditFn;
  /** Resolves the Drive folder backups land in. Defaults to the env var / find-or-create path. */
  resolveFolderId?: () => Promise<string | undefined>;
  now?: () => Date;
  runIdFactory?: () => string;
}

export interface RunBackupOptions {
  includeEphemeral?: boolean;
  /** Restrict the run to these registry collection names (registry order is kept). */
  collections?: string[];
  folderId?: string;
}

export interface BackupManifestCollection {
  name: string;
  backupClass: BackupCollectionEntry['backupClass'];
  count: number;
  sha256: string;
  driveFileId: string;
}

export interface BackupManifest {
  runId: string;
  startedAt: string;
  finishedAt: string;
  collections: BackupManifestCollection[];
  totals: { collections: number; documents: number; bytes: number };
}

export interface BackupRunError {
  collection: string;
  message: string;
}

export interface BackupRunRecord {
  runId: string;
  status: 'success' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string;
  manifestDriveFileId: string | null;
  totals: { collections: number; documents: number; bytes: number };
  errors: BackupRunError[];
}

export interface BackupRunResult extends BackupRunRecord {
  manifest: BackupManifest | null;
}

// --- Defensive Firestore value serialiser ---

/**
 * Convert a Firestore document value into JSON-safe data.
 *
 * SPEC-GAP(F): the spec draft never defines the JSON representation for
 * non-plain Firestore types. Chosen representations, each tagged so a
 * restore script can recognise them:
 *   Timestamp / Date          -> ISO string
 *   GeoPoint                  -> { _type: 'geopoint', latitude, longitude }
 *   DocumentReference         -> { _type: 'reference', path }
 *   Bytes / Buffer / Uint8Array -> { _type: 'bytes', base64 }
 *   undefined                 -> null (so keys are never silently dropped)
 */
export function serializeFirestoreValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { _type: 'bytes', base64: Buffer.from(value as Uint8Array).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeFirestoreValue(item));
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown> & {
      toDate?: () => Date;
      toBase64?: () => string;
      latitude?: unknown;
      longitude?: unknown;
      path?: unknown;
      id?: unknown;
      seconds?: unknown;
      nanoseconds?: unknown;
      _seconds?: unknown;
      _nanoseconds?: unknown;
    };
    // Firestore Timestamp (Admin SDK) exposes toDate().
    if (typeof v.toDate === 'function') {
      try {
        return v.toDate().toISOString();
      } catch {
        // fall through to the seconds/nanoseconds shape below
      }
    }
    // Firestore Bytes exposes toBase64().
    if (typeof v.toBase64 === 'function') {
      return { _type: 'bytes', base64: v.toBase64() };
    }
    // Timestamp-shaped plain object ({ seconds, nanoseconds } or the
    // underscore-prefixed variant some serialised payloads carry).
    const seconds = typeof v.seconds === 'number' ? v.seconds : v._seconds;
    const nanos = typeof v.nanoseconds === 'number' ? v.nanoseconds : v._nanoseconds;
    if (typeof seconds === 'number' && Object.keys(v).every((k) =>
      ['seconds', 'nanoseconds', '_seconds', '_nanoseconds'].includes(k),
    )) {
      return new Date(seconds * 1000 + Math.floor((typeof nanos === 'number' ? nanos : 0) / 1e6)).toISOString();
    }
    // GeoPoint: latitude/longitude are its only data fields.
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number') {
      return { _type: 'geopoint', latitude: v.latitude, longitude: v.longitude };
    }
    // DocumentReference: carries a Firestore path and a parent chain.
    if (
      typeof v.path === 'string' &&
      typeof v.id === 'string' &&
      'parent' in v &&
      'firestore' in v
    ) {
      return { _type: 'reference', path: v.path };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      out[key] = serializeFirestoreValue(item);
    }
    return out;
  }
  return value;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// --- Drive folder resolution ---

let cachedBackupFolderId: string | null = null;

/**
 * Resolve the backups folder: env GOOGLE_DRIVE_BACKUP_FOLDER_ID if set,
 * else find-or-create the "SEDS Backups" folder via the Drive client.
 * Never returns the governance folder and never shares anything.
 */
export async function resolveBackupFolderId(): Promise<string> {
  const fromEnv = process.env[BACKUP_FOLDER_ENV_VAR];
  if (fromEnv) return fromEnv;
  if (cachedBackupFolderId) return cachedBackupFolderId;

  const drive = getDriveClient();
  const found = await drive.files.list({
    q: `name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 5,
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) {
    cachedBackupFolderId = existing;
    return existing;
  }
  const created = await drive.files.create({
    requestBody: {
      name: BACKUP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  const folderId = created.data.id;
  if (!folderId) throw new Error(`Could not create Drive folder "${BACKUP_FOLDER_NAME}"`);
  cachedBackupFolderId = folderId;
  return folderId;
}

// --- Default dependency factory (production wiring) ---

export function createDefaultBackupDeps(): BackupDeps {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin SDK not initialized (getDb() returned null)');
  }
  return {
    db: db as unknown as BackupDb,
    uploadToDrive: async ({ fileName, mimeType, buffer, folderId, makePublic }) => {
      const res = await uploadToVault(fileName, mimeType, buffer, folderId, {
        makePublic,
      });
      return { fileId: res.fileId, webViewLink: res.webViewLink };
    },
    writeRunRecord: async (runId, record) => {
      await db.collection('backup_runs').doc(runId).set(record);
    },
    writeAudit: async (entry) => {
      await db.collection('audit_logs').add(entry);
    },
    resolveFolderId: resolveBackupFolderId,
  };
}

// --- Engine ---

export async function runBackup(
  deps: BackupDeps,
  opts: RunBackupOptions = {},
): Promise<BackupRunResult> {
  const now = deps.now ?? (() => new Date());
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const runId = deps.runIdFactory
    ? deps.runIdFactory()
    : // SPEC-GAP(F): runId format is unspecified in the draft; ISO date plus a uuid keeps ids sortable and collision-free.
      `backup_${startedAtDate.toISOString().slice(0, 10)}_${randomUUID()}`;

  const includeEphemeral = opts.includeEphemeral ?? true;
  let entries = collectionsForBackup(includeEphemeral);
  if (opts.collections) {
    const wanted = new Set(opts.collections);
    entries = entries.filter((entry) => wanted.has(entry.name));
  }

  const folderId =
    opts.folderId ??
    (deps.resolveFolderId ? await deps.resolveFolderId() : undefined);

  const errors: BackupRunError[] = [];
  const manifestCollections: BackupManifestCollection[] = [];
  let totalDocuments = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    try {
      const snap = await deps.db.collection(entry.name).get();
      const docs = snap.docs.map((doc) => ({
        id: doc.id,
        data: serializeFirestoreValue(doc.data() ?? {}),
      }));
      const payload = {
        collection: entry.name,
        exportedAt: startedAt,
        count: docs.length,
        docs,
      };
      const json = JSON.stringify(payload, null, 2);
      const buffer = Buffer.from(json, 'utf8');
      const sha256 = sha256Hex(buffer);
      // SPEC-GAP(F): per-collection Drive file name is unspecified in the draft; the runId prefix prevents runs overwriting each other in the shared backups folder.
      const uploaded = await deps.uploadToDrive({
        fileName: `${runId}__${entry.name}.json`,
        mimeType: 'application/json',
        buffer,
        folderId,
        makePublic: false,
      });
      manifestCollections.push({
        name: entry.name,
        backupClass: entry.backupClass,
        count: docs.length,
        sha256,
        driveFileId: uploaded.fileId,
      });
      totalDocuments += docs.length;
      totalBytes += buffer.length;
    } catch (err) {
      // One collection failing must not abort the run.
      errors.push({
        collection: entry.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finishedAt = now().toISOString();
  const totals = {
    collections: manifestCollections.length,
    documents: totalDocuments,
    bytes: totalBytes,
  };

  const manifest: BackupManifest = {
    runId,
    startedAt,
    finishedAt,
    collections: manifestCollections,
    totals,
  };

  let status: BackupRunRecord['status'] = errors.length > 0 ? 'partial' : 'success';
  let manifestDriveFileId: string | null = null;

  try {
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const uploadedManifest = await deps.uploadToDrive({
      fileName: 'manifest.json',
      mimeType: 'application/json',
      buffer: manifestBuffer,
      folderId,
      makePublic: false,
    });
    manifestDriveFileId = uploadedManifest.fileId;
  } catch (err) {
    status = 'failed';
    errors.push({
      collection: 'manifest',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const record: BackupRunRecord = {
    runId,
    status,
    startedAt,
    finishedAt,
    manifestDriveFileId,
    totals,
    errors,
  };

  try {
    await deps.writeRunRecord(runId, record);
  } catch (err) {
    status = 'failed';
    record.status = 'failed';
    errors.push({
      collection: 'backup_runs',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (status === 'partial' || status === 'failed') {
    // Best-effort alerting: an audit write failure never changes the outcome.
    try {
      await deps.writeAudit({
        action: status === 'partial' ? 'BACKUP_RUN_PARTIAL' : 'BACKUP_RUN_FAILED',
        actorUid: 'system',
        targetUidOrResource: runId,
        payload: { runId, status, totals, errors },
        timestamp: finishedAt,
      });
    } catch {
      // best-effort only
    }
  }

  return { ...record, status, errors, manifest };
}

export { BACKUP_COLLECTIONS };
