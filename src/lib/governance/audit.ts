// Server-side governance audit writer (Workstream D, spec 2.2/4.x).
// Writes to audit_logs via the Admin SDK (getDb from
// src/lib/server/firebase-admin.ts), matching the field shape of the
// existing server audit writers in src/lib/server/ (see
// validation-audit.ts: { type, actorId, targetId, data, timestamp }).
// Do NOT reuse the client helper src/lib/audit-logging.ts here.
//
// Default posture is best-effort: a failed write is console.error'd and
// swallowed so a permitted download can still proceed. Callers passing
// { failClosed: true } (status transitions, access-level changes) get a
// rethrow instead, because those are the acts the audit exists to prove.

import { getDb, admin } from '@/lib/server/firebase-admin';

// Remove undefined values so Firestore never rejects a write with
// invalid-argument, mirroring the sanitize step in the workflow audit
// helper (src/lib/server/workflow-audit.ts).
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

export interface GovernanceAuditOptions {
  failClosed?: boolean;
}

export async function writeGovernanceAudit(
  action: string,
  actorUid: string | null,
  recordId: string | null,
  payload: Record<string, unknown>,
  opts?: GovernanceAuditOptions,
): Promise<boolean> {
  try {
    const db = getDb();
    if (!db) {
      throw new Error('writeGovernanceAudit: no Firestore connection (getDb returned null)');
    }
    await db.collection('audit_logs').doc().set({
      type: action,
      actorId: actorUid,
      targetId: recordId,
      data: sanitize(payload ?? {}),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (error) {
    console.error(`[governance-audit] Failed to write ${action} for record ${recordId}:`, error);
    if (opts?.failClosed) throw error;
    return false;
  }
}
