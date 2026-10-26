/**
 * Server-side audit writer for the elections suite (spec Section 2.1).
 *
 * Same audit_logs field shape as the client helper in
 * src/lib/audit-logging.ts (action, actorUid, targetUidOrResource,
 * payload, timestamp) but THROWS on failure: a governed Returning
 * Officer action must fail when its audit entry cannot be written.
 * No RO action in this workstream may use the client helper.
 *
 * Supabase migration (elections G2): when the 'elections' surface is
 * ON and Supabase is configured, the write/read go through
 * election-domain-supa (audit_logs is a top-level collection ->
 * fs_audit_logs; the stored `timestamp` serverTimestamp sentinel is
 * serialized to an ISO string on write and restored to a
 * Timestamp-shaped object on read). Flag OFF, unconfigured, or any
 * Supabase error -> the exact Firestore path below. Note the
 * fallback nuance: writeElectionAudit THROWS on Firestore failure by
 * design, and it also throws when the Supabase write failed AND the
 * Firestore fallback write failed; a Supabase failure alone never
 * fails a governed action while Firestore can still record it.
 */

import admin from "firebase-admin";
import {
  electionsSupaEnabled,
  supaAddTopDoc,
  supaListTopDocs,
} from "./election-domain-supa";
import { rethrowIfElectionsPrimary } from "./supa-primary";

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
  if (electionsSupaEnabled()) {
    try {
      return await supaAddTopDoc("audit_logs", {
        action: entry.action,
        actorUid: entry.actorUid,
        targetUidOrResource: entry.targetUidOrResource,
        payload: entry.payload ?? {},
        // serializeForSupa stamps the current instant as ISO for the
        // serverTimestamp sentinel, mirroring Firestore resolution.
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        source: "elections_server",
      });
    } catch (err) {
      rethrowIfElectionsPrimary(err);
      // Fall through to the Firestore write below (fallback contract).
    }
  }
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
  if (electionsSupaEnabled()) {
    try {
      const docs = await supaListTopDocs("audit_logs", [
        ["targetUidOrResource", "==", `election:${electionId}`],
      ]);
      return docs.map((d) => ({ id: d.id, ...d.data }));
    } catch {
      // Fall through to the Firestore read below (fallback contract).
    }
  }
  const snap = await db
    .collection("audit_logs")
    .where("targetUidOrResource", "==", `election:${electionId}`)
    .get();
  return snap.docs.map((d: { id: string; data: () => Record<string, unknown> }) => ({
    id: d.id,
    ...d.data(),
  }));
}
