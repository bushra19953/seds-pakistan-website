/**
 * Intake windows: Admin SDK helpers (Workstream E, spec 4.5).
 *
 * Server-side only. All admin window writes go through Admin SDK API
 * routes; these helpers are the shared data layer for those routes:
 * list/get, the intake_config/current mirror writer, and the audit
 * writer that lands in the same batch as a mutation.
 */

import type {
  Firestore,
  WriteBatch,
  DocumentReference,
} from 'firebase-admin/firestore';
import { admin } from '@/lib/server/firebase-admin';
import type {
  IntakeConfig,
  IntakeWindow,
  IntakeWindowKind,
} from '@/types/intake-window';
import {
  resolveWindow,
  timestampLikeToMs,
  windowToLike,
} from '@/lib/intake-windows/resolve';
import {
  mirrorIntakeConfigDoc,
  mirrorIntakeWindowsSnapshot,
} from './intake-windows-supa';

export const INTAKE_WINDOWS_COLLECTION = 'intake_windows';
export const INTAKE_CONFIG_COLLECTION = 'intake_config';
export const INTAKE_CONFIG_DOC_ID = 'current';
export const AUDIT_LOGS_COLLECTION = 'audit_logs';

/**
 * List windows (optionally filtered by kind), sorted by opensAt
 * ascending. Returns the raw stored shape with windowId filled from the
 * doc id when the doc itself omits it.
 */
export async function listWindows(
  db: Firestore,
  kind?: IntakeWindowKind,
): Promise<IntakeWindow[]> {
  const snap = await db.collection(INTAKE_WINDOWS_COLLECTION).get();
  const windows = snap.docs.map((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    return {
      ...(data as unknown as IntakeWindow),
      windowId:
        typeof data.windowId === 'string' ? data.windowId : docSnap.id,
    } as IntakeWindow;
  });
  const filtered = kind ? windows.filter((w) => w.kind === kind) : windows;
  return filtered.sort(
    (a, b) => timestampLikeToMs(a.opensAt) - timestampLikeToMs(b.opensAt),
  );
}

/** Get one window by id, or null when it does not exist. */
export async function getWindow(
  db: Firestore,
  windowId: string,
): Promise<IntakeWindow | null> {
  const docSnap = await db
    .collection(INTAKE_WINDOWS_COLLECTION)
    .doc(windowId)
    .get();
  if (!docSnap.exists) return null;
  const data = (docSnap.data() ?? {}) as Record<string, unknown>;
  return {
    ...(data as unknown as IntakeWindow),
    windowId: typeof data.windowId === 'string' ? data.windowId : docSnap.id,
  } as IntakeWindow;
}

/** Audit entry shape for intake mutations (spec section 5 audit contract). */
export interface IntakeAuditEntry {
  action: string;
  actorUid: string;
  targetUidOrResource: string;
  payload?: unknown;
}

/**
 * Write one audit_logs doc server-side. When a batch is supplied the
 * write joins that batch (so a window change without its audit entry
 * cannot occur through the admin API) and nothing is awaited; otherwise
 * the write is performed immediately. Returns the doc reference.
 */
export async function writeIntakeAudit(
  db: Firestore,
  entry: IntakeAuditEntry,
  batch?: WriteBatch,
): Promise<DocumentReference> {
  const ref = db.collection(AUDIT_LOGS_COLLECTION).doc();
  const data = {
    action: entry.action,
    actorUid: entry.actorUid,
    targetUidOrResource: entry.targetUidOrResource,
    payload: entry.payload ?? null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (batch) {
    batch.set(ref, data);
  } else {
    await ref.set(data);
  }
  return ref;
}

/**
 * Mirror writer (spec 4.5): re-read all kind=induction windows, resolve
 * at server now, and write intake_config/current preserving the existing
 * enforcementEnabled value (a window edit must never silently flip
 * enforcement). mirrorVersion increments on every write;
 * mirrorSourceUpdatedAt carries the resolved window's updatedAt so the
 * admin UI can show mirror health. Returns the written mirror fields.
 */
export async function recomputeAndMirrorConfig(
  db: Firestore,
  actorUid: string,
): Promise<IntakeConfig> {
  const nowMs = Date.now();

  const snap = await db.collection(INTAKE_WINDOWS_COLLECTION).get();
  const likes = snap.docs.map((docSnap) =>
    windowToLike({
      ...(docSnap.data() as Record<string, unknown>),
      windowId: docSnap.id,
    }),
  );
  const resolved = resolveWindow(likes, 'induction', nowMs);

  // The resolved window's raw updatedAt, for mirror-health comparison.
  let mirrorSourceUpdatedAt: unknown = null;
  if (resolved) {
    const sourceDoc = snap.docs.find((d) => d.id === resolved.windowId);
    const raw = sourceDoc?.data() as Record<string, unknown> | undefined;
    if (raw && raw.updatedAt !== undefined && raw.updatedAt !== null) {
      mirrorSourceUpdatedAt = raw.updatedAt;
    }
  }

  const configRef = db
    .collection(INTAKE_CONFIG_COLLECTION)
    .doc(INTAKE_CONFIG_DOC_ID);
  const existingSnap = await configRef.get();
  const existing = existingSnap.exists
    ? ((existingSnap.data() ?? {}) as Record<string, unknown>)
    : {};

  const mirror = {
    currentInductionWindowId: resolved ? resolved.windowId : null,
    currentInductionOpensAt: resolved
      ? admin.firestore.Timestamp.fromMillis(resolved.opensAtMs)
      : null,
    currentInductionClosesAt: resolved
      ? admin.firestore.Timestamp.fromMillis(resolved.closesAtMs)
      : null,
    currentInductionState: resolved ? resolved.state : 'none',
    enforcementEnabled: existing.enforcementEnabled === true,
    mirrorUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    mirrorUpdatedBy: actorUid,
    mirrorSourceUpdatedAt,
    mirrorVersion:
      (typeof existing.mirrorVersion === 'number' ? existing.mirrorVersion : 0) +
      1,
  };

  await configRef.set(mirror, { merge: true });

  // Best-effort Supabase mirrors (step 6 seam, surface
  // 'intake-windows'). recomputeAndMirrorConfig runs after EVERY admin
  // window mutation (create / edit / cancel / uncancel), so this one
  // hook keeps fs_intake_windows and fs_intake_config current with
  // the full snapshot. The mirror copy of the config replaces the
  // serverTimestamp sentinel with an ISO string of the same instant
  // (the adapter's storage shape). Mirror failures never throw.
  await mirrorIntakeWindowsSnapshot(
    snap.docs.map((docSnap) => ({
      id: docSnap.id,
      data: docSnap.data() as Record<string, unknown>,
    })),
  );
  await mirrorIntakeConfigDoc({
    ...mirror,
    mirrorUpdatedAt: new Date().toISOString(),
    mirrorSourceUpdatedAt:
      mirrorSourceUpdatedAt === null
        ? null
        : timestampLikeToMs(mirrorSourceUpdatedAt) > 0
          ? new Date(timestampLikeToMs(mirrorSourceUpdatedAt)).toISOString()
          : mirrorSourceUpdatedAt,
  });

  return mirror as unknown as IntakeConfig;
}
