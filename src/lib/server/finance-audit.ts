import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';

export interface FinanceAuditEntry {
  action: string;
  actorUid: string;
  targetUidOrResource: string;
  payload: Record<string, unknown>;
}

/** Minimal structural view of a Firestore WriteBatch or Transaction. */

export interface AuditWriteTarget {
  // Method signature (bivariant) so both WriteBatch and Transaction from
  // the Admin SDK are assignable without casts at every call site.
  set(ref: DocumentReference, data: Record<string, unknown>): unknown;
}

/**
 * Server-side finance audit writer (spec Part C section 2.2).
 *
 * Unlike src/lib/audit-logging.ts (client helper that swallows its own
 * errors), this writer is used inside the caller's batch/transaction and
 * any failure propagates: if the audit write fails, the money change it
 * accompanies aborts with it. Audit + state change commit atomically.
 *
 * Entry shape matches src/lib/audit-logging.ts plus source: 'server-finance'.
 */
export async function writeFinanceAudit(
  db: Firestore,
  target: AuditWriteTarget,
  entry: FinanceAuditEntry,
): Promise<void> {
  const ref = db.collection('audit_logs').doc();
  target.set(ref, {
    action: entry.action,
    actorUid: entry.actorUid,
    targetUidOrResource: entry.targetUidOrResource,
    payload: entry.payload,
    timestamp: FieldValue.serverTimestamp(),
    source: 'server-finance',
  });
}
