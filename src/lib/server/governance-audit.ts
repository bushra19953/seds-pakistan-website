// ADAPTER: thin local stand-in for the Phase 2 W0 substrate governance-audit
// writer (phase2_spec.md Section 0.5). Replace with the canonical W0 module at
// merge time; the exported signature is the contract and must not change.
//
// Governance differs from the rest of the codebase on purpose: the existing
// audit loggers (src/lib/audit-logging.ts and friends) are best-effort and
// swallow failures. For governance writes that is wrong - if the audit entry
// cannot be written, the action itself must fail. Hence this writer THROWS.

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';

export class GovernanceAuditError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GovernanceAuditError';
  }
}

export interface GovernanceAuditEntry {
  actorUid: string;
  action: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
}

/**
 * Write an entry to audit_logs and return the new doc id.
 * Throws GovernanceAuditError on any failure (including no Admin SDK db);
 * callers must let the throw fail the surrounding action - no state change
 * may be reported as committed when the audit write failed.
 */
export async function writeGovernanceAuditOrThrow(
  entry: GovernanceAuditEntry,
): Promise<string> {
  const db = getDb();
  if (!db) {
    throw new GovernanceAuditError(
      `Governance audit write failed for action "${entry.action}" on ${entry.subjectType}/${entry.subjectId}: Admin SDK unavailable`,
    );
  }
  try {
    const ref = db.collection('audit_logs').doc();
    await ref.set({
      actorUid: entry.actorUid,
      actor: entry.actorUid,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      details: entry.details ?? {},
      governance: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    throw new GovernanceAuditError(
      `Governance audit write failed for action "${entry.action}" on ${entry.subjectType}/${entry.subjectId}`,
      err,
    );
  }
}
