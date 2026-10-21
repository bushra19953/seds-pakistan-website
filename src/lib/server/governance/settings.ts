/**
 * Governance feature gate (ws-a §9) — server only.
 *
 * settings/governance.enabled gates every governance MUTATION. Default
 * is TRUE when the doc or the field is absent (the platform flag ships
 * default-true after go-live; the kill switch is setting it false).
 * Reads of minutes and of the decision register stay allowed while
 * disabled so the record remains inspectable; mutations return
 * 503 governance_disabled.
 */

import { getDb } from "@/lib/server/firebase-admin";
import { GovernanceServiceError } from "./shared";

export async function isGovernanceEnabled(): Promise<boolean> {
  const db = getDb();
  if (!db) return true; // no Admin SDK locally: the gate cannot be off
  const snap = await db.doc("settings/governance").get();
  if (!snap.exists) return true;
  const enabled = snap.data()?.enabled;
  return enabled !== false;
}

/** Throw 503 governance_disabled when the switch is off (mutations only). */
export async function requireGovernanceEnabled(): Promise<void> {
  if (!(await isGovernanceEnabled())) {
    throw new GovernanceServiceError(
      "governance_disabled",
      503,
      "Governance features are currently disabled by the platform switch",
    );
  }
}
