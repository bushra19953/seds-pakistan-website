/**
 * Scoped db-acquisition indirection for the compliance cron pair
 * (cutover program, Option A — the seam point Zubair's order authorizes
 * for the C-G2-2 hard stop in cluster-cron/BUILDOUT_REPORT.md).
 *
 * The compliance engines (compliance/cron, compliance/generator,
 * compliance/report-service), governance-settings (string form of
 * isPhase2Live), governance-audit (single-argument form) and
 * compliance-role-holders all SELF-ACQUIRE their db via getDb() and
 * take no db parameter; the routes' pinned contracts also fix their
 * delegation argument lists (runComplianceCron(Date) — one argument;
 * generate/deliverQuarterlyReport(quarterKey, 'cron', Date)), so the
 * G1/G2/G3 route-passed-db pattern cannot wire these two routes
 * without breaking pinned contracts or forking platform-wide modules.
 *
 * This module is the minimal seam instead: an AsyncLocalStorage
 * carrying ONE db handle for the duration of a cron run. The six
 * self-acquisition points consult `currentComplianceDb()` first and
 * fall back to exactly the getDb() they used before:
 *
 *   const db = currentComplianceDb() ?? getDb();
 *
 * Properties:
 * - No context active (every caller except the two cron routes, in
 *   every flag state): byte-identical to the pre-seam tree — the
 *   override is never consulted with a non-null value.
 * - Context active (only inside runWithComplianceDb, called only by
 *   the compliance / compliance-report cron routes when the seam
 *   getter returns a handle): those modules run against the handle.
 * - ALS scoping, not a module-level setter: concurrent invocations
 *   cannot cross-contaminate, and the override cannot leak into a
 *   later request.
 *
 * Server-only (node:async_hooks); both cron routes are runtime
 * 'nodejs'.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Firestore } from 'firebase-admin/firestore';

// The handle carried here is Firestore-shaped (SupaDbHandle from
// supa-db-handle.ts, a structural emulation of the Admin SDK
// surface). It is stored opaquely and surfaced typed as Firestore —
// exactly the static type every consuming module's getDb() returned
// before the seam — so the consumers' callback typings are unchanged
// and this module gains no import edge into the cron seam modules.
const storage = new AsyncLocalStorage<{ db: unknown }>();

/**
 * Run `fn` with `db` as the compliance acquisition override. Returns
 * fn's result; the context is restored on settle (including throws).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runWithComplianceDb<T>(
  db: any,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ db }, fn);
}

/**
 * The db the compliance self-acquiring modules must use right now:
 * the scoped override inside a cron run, or null (callers fall back
 * to their own getDb(), byte-identical to the pre-seam behaviour).
 */
export function currentComplianceDb(): Firestore | null {
  const db = storage.getStore()?.db;
  return (db as Firestore | undefined) ?? null;
}
