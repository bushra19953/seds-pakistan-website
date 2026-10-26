/**
 * G4 seam — backup + admin-export data paths (cluster S, group G4).
 *
 * This module is the group's ONLY new importer of the shared Supabase
 * db handle (`src/lib/server/supa-db-handle.ts`). Every G4 route
 * obtains its db here:
 *
 *   - `getG4Handle()` — the adapter-backed Firestore-shaped handle when
 *     the 'backup-exports' surface flag is ON and a Supabase client is
 *     configured, else null.
 *   - `getG4Db()` — that handle, else the real Firestore db from
 *     `getDb()` (which may itself be null; routes keep their existing
 *     null-db error responses). With the flag OFF this returns exactly
 *     what `getDb()` returns, so flag-off behavior is byte-identical.
 *
 * Coverage notes (which paths actually move under the flag):
 *   - admin/backup-runs: the backup_runs list read.
 *   - admin/governance-records/export: the permission gate's db, the
 *     registration-status read, and the GOVERNANCE_COLLECTION full get.
 *     `writeGovernanceAudit` (src/lib/governance/audit) self-acquires
 *     its db internally and takes no db parameter, so the audit write
 *     STAYS on Firestore — partial coverage, by design (C-G4-3: the
 *     two audit modules are never unified or forked by this group).
 *   - admin/governors/export: the db passed to `getRegister` and to
 *     `writeGovernanceAuditOrThrow`. The db inside
 *     `authenticateGovernorRequest` (src/lib/server/governors/http)
 *     self-acquires and stays Firestore; the route overrides the db
 *     it hands to the register/audit libraries with this seam's.
 *   - admin/partners/export: the sponsors_partners full get, the
 *     permission check's db, and the db + batch handed to
 *     `writeFinanceAudit` (audit-before-serve ordering preserved: the
 *     batch commit still precedes the response).
 *   - cron/backup: the bounded-read wrapper runs over this handle
 *     with an explicit Firestore fallback (see the route), and the
 *     backup_runs run-record write routes through the handle.
 *     Flip-readiness for cron/backup is STAYS-FIRESTORE regardless:
 *     the backup must remain a copy of the source of record, and
 *     routing its reads through the mirror inverts that (PLAN_G4 §4,
 *     merge plan C-19). The wiring exists so a future per-surface
 *     source-of-record switch has somewhere to land.
 *
 * Server-only: never import from client components.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getDb } from '@/lib/server/firebase-admin';
import {
  rehydrateTimestampFields,
  supaDbHandleFor,
  type SupaDbHandle,
} from '@/lib/server/supa-db-handle';
import { requireHandleUnderPrimacy } from '@/lib/server/cron/cron-primacy';

export const BACKUP_EXPORTS_SURFACE = 'backup-exports';

/** The adapter-backed handle when the surface is ON, else null. */
export function getG4Handle(): SupaDbHandle | null {
  return supaDbHandleFor(BACKUP_EXPORTS_SURFACE);
}

/**
 * The db G4 routes use: the Supabase handle when the 'backup-exports'
 * flag is ON, otherwise the real Firestore db (possibly null, exactly
 * as `getDb()` returns it). Typed as Firestore because the handle is a
 * structural emulation of that surface (see supa-db-handle's header).
 */
export function getG4Db(): Firestore | null {
  // Cutover primacy: under isSupaPrimary('backup-exports') an
  // unavailable handle throws (CronPrimaryUnavailableError) — an
  // export silently served from Firestore while Supabase is the
  // source of record would be a wrong answer, not a fallback.
  // PRIMARY off: handle-when-ON, else getDb(), exactly as before.
  const handle = requireHandleUnderPrimacy(
    BACKUP_EXPORTS_SURFACE,
    getG4Handle(),
  );
  if (handle) return handle as unknown as Firestore;
  return getDb() as Firestore | null;
}

/**
 * Partners/export timestamp rehydration (PLAN_G4 §3).
 *
 * The export renders `createdAt`, `updatedAt`, and each
 * interactionHistory entry's `timestamp` via `.toDate?.()` — under the
 * adapter, adapter-written timestamps arrive as ISO strings, `.toDate`
 * is absent, and those cells silently blank. This converts exactly
 * those fields from ISO strings to Timestamp-like objects
 * (SupaTimestamp, which carries toDate()/toISOString()) so the CSV
 * cells match the Firestore-shaped output. Dumped timestamps already
 * come back from the adapter as SupaTimestamp and pass through
 * untouched, as do Dates and real Firestore Timestamps.
 *
 * Callers apply this ONLY when the seam handle served the read, so
 * flag-off (Firestore) behavior is untouched.
 */
export function rehydratePartnerTimestamps<T extends Record<string, unknown>>(
  data: T,
): T {
  const out = rehydrateTimestampFields(data, ['createdAt', 'updatedAt']);
  const history = (out as Record<string, unknown>).interactionHistory;
  if (Array.isArray(history)) {
    (out as Record<string, unknown>).interactionHistory = history.map(
      (entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? rehydrateTimestampFields(
              entry as Record<string, unknown>,
              ['timestamp'],
            )
          : entry,
    );
  }
  return out;
}
