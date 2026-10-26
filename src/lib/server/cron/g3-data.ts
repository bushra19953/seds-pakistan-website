/**
 * Group G3 seam (Supabase migration, cluster cron) — the ONLY new
 * importer of the shared db handle for the G3 routes:
 *   - src/app/api/cron/clear-probation/route.ts
 *   - src/app/api/cron/process-dlq/route.ts
 *   - src/app/api/cron/retention/route.ts
 *   - src/app/api/cron/overdue/route.ts
 *
 * `getG3Db()` returns the adapter-backed Firestore-shaped handle
 * (src/lib/server/supa-db-handle.ts) when the 'cron-g3' surface flag is
 * ON and a Supabase client is configured; otherwise it returns the real
 * Firestore db from getDb(), byte-identical to the pre-migration code.
 *
 * The routes pass the returned db to the SHARED libraries exactly as
 * before — discipline/derived-counter, discipline/stanzas,
 * discipline/adapters-probation and the retention engine all take `db`
 * (or `deps.db`) as a parameter and are never edited or forked here.
 * The handle's emulation contract (collect-then-commit batches,
 * live-read + buffered-write transactions, sentinel resolution against
 * fresh state, count() aggregates, subcollection addressing) is stated
 * once in supa-db-handle.ts and relied on by this group for:
 *   - process-dlq's mega-batch + FieldValue.increment set-merge +
 *     .count().get() existence check (PLAN_G3 C-G3-1/2/3),
 *   - clear-probation's users/{uid}/warnings subcollection reads,
 *     per-user batches and the derived counter's transaction-shaped
 *     write helper (C-G3-4/5),
 *   - overdue's chunked batches and settings/next-step queries,
 *   - retention's engine reads/writes and the route's audit_logs add.
 *
 * KNOWN PARTIAL COVERAGE (documented, not worked around):
 * notificationService (used by clear-probation for the best-effort
 * 'probation_cleared' notice) self-acquires its db via getDb() inside
 * src/lib/server/notification-service.ts and takes no db parameter, so
 * under the flag its notification writes still land in Firestore. The
 * library is shared platform-wide and is NOT edited by this group.
 */
import { getDb } from '../firebase-admin';
import { supaDbHandleFor } from '../supa-db-handle';
import { requireHandleUnderPrimacy } from './cron-primacy';

export const G3_SURFACE = 'cron-g3';

/**
 * The db the G3 routes and their delegated libraries run against:
 * the Supabase handle when 'cron-g3' is ON, else the real Firestore db
 * (which may be null when Admin is not initialized — callers keep
 * their existing null checks and error responses, unchanged).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getG3Db(): any {
  // Cutover primacy: under isSupaPrimary('cron-g3') an unavailable
  // handle throws (CronPrimaryUnavailableError) — no silent
  // Firestore fallback while the adapter is the sole writer.
  // PRIMARY off: handle-when-ON, else getDb(), exactly as before.
  const handle = requireHandleUnderPrimacy(
    G3_SURFACE,
    supaDbHandleFor(G3_SURFACE),
  );
  return handle ?? getDb();
}
