/**
 * Server-side audit writer for the elections suite (spec Section 2.1).
 *
 * Same audit_logs field shape as the client helper in
 * src/lib/audit-logging.ts (action, actorUid, targetUidOrResource,
 * payload, timestamp) but THROWS on failure: a governed Returning
 * Officer action must fail when its audit entry cannot be written.
 * No RO action in this workstream may use the client helper.
 */

import admin from "firebase-admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface ElectionAuditEntry {
  action: string;
  actorUid: string;
  targetUidOrResource: string;
  payload?: Record<string, unknown>;
}

export async function writeElectionAudit(
  db: Db,
  entry: ElectionAuditEntry,
): Promise<string> {
  const ref = db.collection("audit_logs").doc();
  await ref.set({
    action: entry.action,
    actorUid: entry.actorUid,
    targetUidOrResource: entry.targetUidOrResource,
    payload: entry.payload ?? {},
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    source: "elections_server",
  });
  return ref.id;
}

/** Read back the audit entries for one election (RO console Audit tab). */
export async function listElectionAudit(
  db: Db,
  electionId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db
    .collection("audit_logs")
    .where("targetUidOrResource", "==", `election:${electionId}`)
    .get();
  return snap.docs.map((d: { id: string; data: () => Record<string, unknown> }) => ({
    id: d.id,
    ...d.data(),
  }));
}
