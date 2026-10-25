/**
 * Group G2 seam (Supabase migration, cluster cron) — the ONLY new
 * importer of the shared db handle for the G2 routes:
 *   - src/app/api/cron/consent-deadlines/route.ts
 *   - src/app/api/cron/elections-lifecycle/route.ts
 *   - src/app/api/cron/governance/route.ts
 *   - src/app/api/cron/custom-role-expiry-sweep/route.ts
 *
 * `getG2Db()` returns the adapter-backed Firestore-shaped handle
 * (src/lib/server/supa-db-handle.ts) when the 'cron-g2' surface flag is
 * ON and a Supabase client is configured; otherwise it returns the real
 * Firestore db from getDb(), byte-identical to the pre-migration code.
 *
 * The routes pass the returned db to the SHARED engines exactly as
 * before — consent-service (stampDeemedWithheld), elections
 * (runElectionLifecycleSweeps), lifecycle-cron (runGovernanceCron) and
 * custom-role-expiry-sweep all take `db` as a parameter and are never
 * edited or forked here. The handle's emulation contract
 * (collect-then-commit batches, live-read + buffered-write
 * transactions, sentinel resolution against fresh state, count()
 * aggregates, subcollection addressing) is stated once in
 * supa-db-handle.ts and relied on by this group for:
 *   - stampDeemedWithheld's status-recheck transaction (PLAN_G2
 *     C-G2-1) incl. its consent_requests/{id}/history subcollection
 *     write and audit_logs write,
 *   - the elections sweep's full elections get, nominations count()
 *     and status updates,
 *   - the governance dispatcher's action modules (consent ratification
 *     stamps, vacancy scans, probation-restore retries),
 *   - the expiry sweep's roles full get, per-user writes and the
 *     assignRole batch.
 *
 * KNOWN PARTIAL / ZERO COVERAGE (documented, not worked around):
 *   - compliance and compliance-report: NO seam point exists. Their
 *     engines (compliance/cron, compliance/report-service),
 *     governance-settings (the complianceLive flag read) and
 *     governance-audit (single-argument form) ALL self-acquire their
 *     db via getDb() and take no db parameter, so the 'cron-g2' flag
 *     does not move those two routes at all. The shared modules are
 *     platform-wide; they migrate ONCE under their owning cluster
 *     (PLAN_G2 C-G2-2) and this group does not fork them.
 *   - notificationService (consent-deadlines' deemed-withheld and
 *     founder-warning notices; the expiry sweep's alerts)
 *     self-acquires its db and takes no db parameter, so under the
 *     flag its notification writes still land in Firestore.
 *   - governance-settings reads inside lifecycle-cron's actions follow
 *     the same rule wherever an action self-acquires instead of using
 *     the dispatched db.
 */
import { getDb } from '../firebase-admin';
import { supaDbHandleFor } from '../supa-db-handle';

export const G2_SURFACE = 'cron-g2';

/**
 * The db the G2 routes and their delegated engines run against:
 * the Supabase handle when 'cron-g2' is ON, else the real Firestore db
 * (which may be null when Admin is not initialized — callers keep
 * their existing null checks and error responses, unchanged).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getG2Db(): any {
  return supaDbHandleFor(G2_SURFACE) ?? getDb();
}
