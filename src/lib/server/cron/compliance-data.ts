/**
 * Compliance cron pair seam getter (cutover program, Option A).
 *
 * The compliance pair was cluster-cron G2's unwired remainder
 * (BUILDOUT_REPORT C-G2-2): its engines self-acquire, so instead of a
 * route-passed db (the G1/G2/G3 pattern) the routes obtain the handle
 * HERE and run their existing, contract-pinned delegation calls
 * inside `runWithComplianceDb(handle, ...)`
 * (src/lib/server/cron/compliance-db-context.ts). The engines,
 * governance-settings, governance-audit and compliance-role-holders
 * consult that context at their self-acquisition points and otherwise
 * resolve getDb() exactly as before.
 *
 * Surface: compliance inherits the G2 surface token ('cron-g2') — it
 * was G2's pair; no new token is invented.
 *
 * Flag law:
 * - 'cron-g2' OFF / no Supabase client: returns null; the routes run
 *   unwrapped and every module self-acquires Firestore — byte-
 *   identical to the pre-seam tree.
 * - 'cron-g2' ON: returns the shared adapter-backed handle
 *   (supa-db-handle.ts); the pair's data reads/writes run on Supabase
 *   through it (notificationService excepted — it self-acquires and
 *   is the cluster's named split in every flag state).
 * - isSupaPrimary('cron-g2') with NO handle available: THROWS
 *   CronPrimaryUnavailableError — under primacy the adapter is the
 *   sole writer, and silently falling back to Firestore would split
 *   the surface. The routes surface this as a failed run (500),
 *   never as a Firestore run.
 */

import { supaDbHandleFor } from '../supa-db-handle';
import { requireHandleUnderPrimacy } from './cron-primacy';

export { CronPrimaryUnavailableError, requireHandleUnderPrimacy } from './cron-primacy';

/** The G2 surface token (defined in g2-data.ts; compliance inherits it). */
export const COMPLIANCE_CRON_SURFACE = 'cron-g2';
const G2_SURFACE = COMPLIANCE_CRON_SURFACE;

/**
 * The db the compliance cron pair runs against: the adapter handle
 * when 'cron-g2' is ON, else null (routes run unwrapped = today's
 * Firestore self-acquisition). Throws under primacy without a handle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getComplianceDb(): any | null {
  const handle = requireHandleUnderPrimacy(
    G2_SURFACE,
    supaDbHandleFor(G2_SURFACE),
  );
  return handle;
}
