// ADAPTER(W0): Local implementation of the Section 0.5 governance audit writer
// until the Phase 2 substrate (feat/bylaws-p2-consent) lands. The substrate
// version replaces this module at integration; the signature and the
// throw-on-failure contract are fixed by spec Section 0.5 and must not change.
//
// The existing best-effort loggers (src/lib/audit-logging.ts) deliberately do
// not throw and are WRONG for governance writes; nothing in Phase 2 may use
// them for a governance action.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export class GovernanceAuditError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GovernanceAuditError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export interface GovernanceAuditEntry {
  action: string;
  actorUid: string;
  actorRole?: string | null;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/**
 * Writes one entry to audit_logs in the established shape
 * ({ action, actorUid, targetUidOrResource, payload, timestamp }) and returns
 * the new doc id. THROWS GovernanceAuditError on failure: per substrate
 * contract 4, an audit failure on a governance action means the action fails.
 */
export async function writeGovernanceAuditOrThrow(
  db: Firestore,
  entry: GovernanceAuditEntry,
): Promise<string> {
  try {
    const targetUidOrResource =
      entry.targetType && entry.targetId
        ? `${entry.targetType}/${entry.targetId}`
        : entry.targetId ?? entry.targetType ?? '';
    const ref = await db.collection('audit_logs').add({
      action: entry.action,
      actorUid: entry.actorUid,
      actorRole: entry.actorRole ?? null,
      targetUidOrResource,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      payload: entry.details ?? {},
      timestamp: FieldValue.serverTimestamp(),
      governance: true,
    });
    return ref.id;
  } catch (err) {
    throw new GovernanceAuditError(
      `governance audit write failed for action ${entry.action}`,
      err,
    );
  }
}
