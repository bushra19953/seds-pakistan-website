import { admin, getDb } from '@/lib/server/firebase-admin';

/**
 * Shared server-side upload tracking helper.
 *
 * Every file upload should log an `upload_logs` Firestore document so uploads
 * are tracked server-side even when the client never attaches the file to a
 * task (the green-checkmark-without-attach UX trap).
 */

const UPLOAD_LOGS_COLLECTION = 'upload_logs';

/** Convert a Firestore timestamp / Date / number to millis for client-side sorting. */
function tsToMillis(v: any): number {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return 0;
}

export interface UploadLogEntry {
  userId: string;
  fileName: string;
  /** Server-generated stable name for this upload session (kind + timestamp + sanitized filename). */
  uniqueName?: string;
  fileSizeBytes?: number;
  mimeType?: string;
  /** e.g. 'evidence' | 'submission' | 'portfolio' | 'media' */
  kind?: string;
  /** e.g. 'task-submission' | 'chat' | 'profile' - free-form caller context */
  context?: string;
  driveFileId?: string;
  webViewLink?: string;
  taskId?: string | null;
  status: 'initiated' | 'completed' | 'attached';
  uploadedAt?: any;
}

export type UploadLogStatus = UploadLogEntry['status'];

export interface UploadLogRecord extends UploadLogEntry {
  id: string;
}

/**
 * Write a new upload log entry. Fire-and-forget safe: never throws,
 * returns the created doc id or null on failure.
 */
export async function logUpload(entry: UploadLogEntry): Promise<string | null> {
  try {
    const db = getDb();
    if (!db) return null;
    const ref = await db.collection(UPLOAD_LOGS_COLLECTION).add({
      ...entry,
      taskId: entry.taskId ?? null,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('[upload-logger] logUpload failed:', err);
    return null;
  }
}

/**
 * Mark an upload's 'initiated' log (written by /api/uploads/initiate) as
 * 'completed'. Finds the log by uniqueName - the stable session identifier
 * returned to the browser at initiation time. If no initiated log exists
 * (e.g. its write was lost), a completed log entry is written directly so
 * the log stays complete. Never throws.
 */
export async function markUploadCompleted(
  uniqueName: string,
  details: {
    userId: string;
    kind?: string;
    driveFileId: string;
    fileSizeBytes?: number;
    webViewLink?: string | null;
  },
): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const completion = {
      status: 'completed' as const,
      driveFileId: details.driveFileId,
      fileSizeBytes: details.fileSizeBytes ?? 0,
      webViewLink: details.webViewLink ?? null,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (uniqueName) {
      const snap = await db
        .collection(UPLOAD_LOGS_COLLECTION)
        .where('uniqueName', '==', uniqueName)
        .limit(1)
        .get();
      if (!snap.empty) {
        await snap.docs[0].ref.update(completion);
        return;
      }
    }
    await db.collection(UPLOAD_LOGS_COLLECTION).add({
      ...completion,
      userId: details.userId,
      fileName: uniqueName || details.driveFileId,
      uniqueName: uniqueName || null,
      kind: details.kind,
      initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[upload-logger] markUploadCompleted failed:', err);
  }
}

/**
 * Mark an upload as attached to a task (when the Drive file actually gets
 * attached to a task doc / submission). Never throws.
 */
export async function markUploadAttached(driveFileId: string, taskId: string): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const snap = await db
      .collection(UPLOAD_LOGS_COLLECTION)
      .where('driveFileId', '==', driveFileId)
      .limit(1)
      .get();
    if (snap.empty) return;
    await snap.docs[0].ref.update({
      status: 'attached',
      taskId,
      attachedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[upload-logger] markUploadAttached failed:', err);
  }
}

/**
 * Return completed-but-unattached uploads older than the threshold -
 * these are the files users uploaded but never actually attached/submitted.
 * Never throws (returns [] on failure).
 */
export async function findOrphanedUploads(olderThanHours = 2): Promise<any[]> {
  try {
    const db = getDb();
    if (!db) return [];
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const snap = await db
      .collection(UPLOAD_LOGS_COLLECTION)
      .where('status', '==', 'completed')
      .where('uploadedAt', '<', cutoff)
      .orderBy('uploadedAt', 'asc')
      .get();
    return snap.docs
      .filter((d) => {
        const data = d.data();
        return data.taskId == null;
      })
      .map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('[upload-logger] findOrphanedUploads failed:', err);
    return [];
  }
}

/**
 * Get all upload logs attached to a given task. Never throws.
 */
export async function getUploadsForTask(taskId: string): Promise<UploadLogRecord[]> {
  try {
    const db = getDb();
    if (!db) return [];
    const snap = await db
      .collection(UPLOAD_LOGS_COLLECTION)
      .where('taskId', '==', taskId)
      .get();
    // Sort client-side instead of orderBy() so the query needs no
    // composite index (equality + orderBy on different fields requires
    // a manually created Firestore composite index).
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as UploadLogEntry) }))
      .sort((a, b) => tsToMillis(b.uploadedAt) - tsToMillis(a.uploadedAt));
  } catch (err) {
    console.error('[upload-logger] getUploadsForTask failed:', err);
    return [];
  }
}

/**
 * Get the most recent upload logs for a user. Never throws.
 */
export async function getUploadsForUser(userId: string, limit = 50): Promise<UploadLogRecord[]> {
  try {
    const db = getDb();
    if (!db) return [];
    const snap = await db
      .collection(UPLOAD_LOGS_COLLECTION)
      .where('userId', '==', userId)
      .get();
    // Client-side sort + limit to avoid a composite index requirement.
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as UploadLogEntry) }))
      .sort((a, b) => tsToMillis(b.uploadedAt) - tsToMillis(a.uploadedAt))
      .slice(0, limit);
  } catch (err) {
    console.error('[upload-logger] getUploadsForUser failed:', err);
    return [];
  }
}
