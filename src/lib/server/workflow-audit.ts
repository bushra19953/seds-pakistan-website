/**
 * Server-side audit helper for workflow CRUD operations.
 *
 * Writes audit entries to the top-level `workflow_audits` collection, following
 * the field conventions already used by the workflows API route
 * (see src/app/api/workflows/route.ts): workflowId plus an actor identifier
 * plus a server-generated createdAt timestamp.
 *
 * Auditing must never break the main operation, so this helper never throws:
 * every write is wrapped in try/catch and failures are logged.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export type WorkflowAuditAction =
  | 'workflow_deleted'
  | 'workflow_duplicated'
  | 'workflows_bulk_deleted';

export interface WorkflowAuditEntry {
  action: WorkflowAuditAction;
  workflowId: string;
  actorUid: string;
  details?: Record<string, unknown>;
}

// Remove undefined values so Firestore never rejects a write with
// invalid-argument, mirroring the sanitize step in src/lib/audit-logging.ts.
function sanitize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(sanitize).filter((v) => v !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = sanitize(v);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return value;
}

export async function logWorkflowAudit(
  db: Firestore,
  entry: WorkflowAuditEntry
): Promise<void> {
  try {
    const doc: Record<string, unknown> = {
      action: entry.action,
      workflowId: entry.workflowId,
      actorUid: entry.actorUid,
      details: sanitize(entry.details ?? null),
      createdAt: FieldValue.serverTimestamp(),
    };
    await db.collection('workflow_audits').add(doc);
  } catch (error) {
    console.error('logWorkflowAudit - failed to write audit entry:', error);
  }
}
