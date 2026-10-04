/**
 * Hierarchical Validation Audit (Server-side)
 *
 * Records who validated a task, their position relative to the submitter,
 * and denied validation attempts. Writes go to the existing `audit_logs`
 * collection (Admin SDK; reads gated by canViewAuditLogs).
 * Every function is non-throwing: audit failure must never fail the approval.
 */

import { getDb, admin } from '@/lib/server/firebase-admin';
import type { ValidationVia } from '@/lib/server/hierarchy';

export interface ValidationAuditEntry {
  taskId: string;
  validatorUid: string;
  validatorRole: string;
  validatorDepth: number | null;
  via: ValidationVia;
  submitterUid: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}

/**
 * Log a completed validation decision: validator identity, role, depth in
 * the reporting chain above the submitter (null when via assigner/role),
 * which grant authorized it, and the timestamp.
 */
export async function logValidationDecision(entry: ValidationAuditEntry): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      console.warn('[validation-audit] No db, skipping decision audit');
      return;
    }
    await db.collection('audit_logs').doc().set({
      type: 'TASK_VALIDATED',
      actorId: entry.validatorUid,
      targetId: entry.taskId,
      data: {
        validatorRole: entry.validatorRole,
        validatorDepth: entry.validatorDepth,
        via: entry.via,
        submitterUid: entry.submitterUid,
        decision: entry.decision,
        reason: entry.reason || null,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[validation-audit] Failed to log decision:', e);
  }
}

export interface DeniedValidationEntry {
  taskId: string;
  callerUid: string;
  callerRole: string;
  reason: string;
}

/**
 * Log an unauthorized validation attempt (403). Used to detect probing
 * or privilege-escalation attempts against the validation gate.
 */
export async function logDeniedValidationAttempt(entry: DeniedValidationEntry): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      console.warn('[validation-audit] No db, skipping denied-attempt audit');
      return;
    }
    await db.collection('audit_logs').doc().set({
      type: 'TASK_VALIDATION_DENIED',
      actorId: entry.callerUid,
      targetId: entry.taskId,
      data: {
        callerRole: entry.callerRole,
        reason: entry.reason,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[validation-audit] Failed to log denied attempt:', e);
  }
}
