/**
 * Throwing governance audit writer (Phase 2).
 *
 * Governance writes MUST be audited: unlike the existing best-effort
 * loggers (src/lib/audit-logging.ts, workflow-audit.ts, validation-audit.ts),
 * which swallow failures, this writer throws GovernanceAuditError on any
 * failure so the calling governance action fails and no state change is
 * committed unaudited. Do NOT use the best-effort loggers for governance.
 *
 * Field names/shape mirror the existing audit_logs conventions
 * (action, actorUid, details payload, serverTimestamp): the timestamp is
 * written as `createdAt`, matching the server-side audit helpers.
 */

import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './firebase-admin';

export class GovernanceAuditError extends Error {
  constructor(message = 'Failed to write governance audit entry', cause?: unknown) {
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
  actorRole?: string;
  targetType?: string;
  targetId?: string;
  // Cadetship+Compliance entry aliases (integration step 7): their
  // writer named these subjectType/subjectId. Both spellings are
  // accepted and normalised to targetType/targetId on write.
  subjectType?: string;
  subjectId?: string;
  details?: Record<string, unknown>;
}

export interface GovernanceAuditOptions {
  batch?: WriteBatch;
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

/**
 * Write an audit_logs entry for a governance action.
 *
 * Without a batch: awaits the write and throws GovernanceAuditError on
 * any failure. With opts.batch: adds a set op to the batch and returns
 * the new doc id without awaiting; commit errors are the caller's.
 *
 * Returns the audit doc id in both paths.
 */
export async function writeGovernanceAuditOrThrow(
  dbOrEntry: Firestore | GovernanceAuditEntry,
  entryMaybe?: GovernanceAuditEntry,
  opts?: GovernanceAuditOptions
): Promise<string> {
  // Dual signature (integration step 7): Workstream A/Gates call
  // (db, entry, opts?); Cadetship+Compliance call (entry) with the db
  // resolved internally - their writer's contract. Both are honored;
  // the written doc shape is the canonical one below either way.
  let db: Firestore | null;
  let entry: GovernanceAuditEntry;
  if (
    entryMaybe === undefined &&
    !!dbOrEntry &&
    typeof dbOrEntry === 'object' &&
    typeof (dbOrEntry as GovernanceAuditEntry).action === 'string'
  ) {
    entry = dbOrEntry as GovernanceAuditEntry;
    db = getDb();
    if (!db) {
      throw new GovernanceAuditError(
        `Governance audit write failed for action "${entry.action}": Admin SDK unavailable`,
      );
    }
  } else {
    db = dbOrEntry as Firestore;
    entry = entryMaybe as GovernanceAuditEntry;
  }
  const targetType = entry.targetType ?? entry.subjectType;
  const targetId = entry.targetId ?? entry.subjectId;
  const ref = db.collection('audit_logs').doc();

  const data: Record<string, unknown> = {
    action: entry.action,
    actorUid: entry.actorUid,
    ...(entry.actorRole !== undefined ? { actorRole: entry.actorRole } : {}),
    ...(targetType !== undefined ? { targetType } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
    details: sanitize(entry.details ?? null),
    governance: true,
    createdAt: FieldValue.serverTimestamp(),
  };

  if (opts?.batch) {
    try {
      opts.batch.set(ref, data);
    } catch (error) {
      throw new GovernanceAuditError('Failed to add governance audit entry to batch', error);
    }
    return ref.id;
  }

  try {
    await ref.set(data);
  } catch (error) {
    throw new GovernanceAuditError('Failed to write governance audit entry', error);
  }
  return ref.id;
}
