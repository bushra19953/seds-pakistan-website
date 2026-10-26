/**
 * Custom role expiry sweep (Custom Roles Fix Program, contracts 5).
 *
 * Read-time derivation (customGrantStatus, src/lib/custom-roles.ts) is
 * the record of whether a grant IS expired; this sweep only
 * materialises and alerts, on the governors term-sweep pattern
 * (src/lib/server/governors/term-sweep.ts) for scheduling/alerting and
 * the probation pattern (lifecycle-probation.ts) for restore
 * semantics:
 *
 * - A roles doc whose pending expiry (expiresAt + a custom_
 *   expiresRoleKey) is inside 30 days and whose stage allows it gets
 *   the T-30 alert, then the T-7 alert inside 7 days; each alert
 *   stamps expiryAlertStage on the doc (that bookkeeping field ONLY -
 *   the grant composition, expiresAt and the snapshot are never
 *   mutated before the expiry instant). Recipients: the Founder and
 *   the grant holder. Reminders write no governance audit.
 * - At expiry (now >= expiresAt) the grant is materialised through
 *   ONE assignRole call (actorUid 'system', source 'expiry_sweep',
 *   deterministic idempotencyKey), preceded by the contracts 5.4
 *   governance audit (audit-or-fail: if the audit write throws, no
 *   state changes). Branch rule (contracts 5.3 + ADDENDUM R4):
 *   restored_prior only when NOTHING changed since the grant - the
 *   additionalRoles set still equals priorAdditionalRoles union
 *   {expiresRoleKey} AND the primary is still the captured priorRole;
 *   a banned holder is escalated_banned_no_restore (slug removed,
 *   nothing restored); anything else is removed_only (current state
 *   wins, the stale snapshot is never written). A chain of expiring
 *   grants restores the state before the chain's FIRST grant
 *   (ADDENDUM R1): role-writes' capture already stores that snapshot,
 *   so the sweep simply honours the stored prior fields.
 * - Per-grant failures are isolated into summary.failures and a
 *   failed materialisation alerts the Founder; one bad grant never
 *   blocks the sweep, and the sweep never throws to its host.
 *
 * Hosted as a named step of /api/cron/check-deadlines plus the manual
 * trigger /api/cron/custom-role-expiry-sweep (contracts 5.1, R2/R3).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/config/founder';
import {
  RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES,
  customGrantStatus,
  isCustomRoleSlug,
  toCustomRoleDefinition,
} from '../custom-roles';
import { isCatalogRoleKey, type CatalogRoleKey } from '../role-catalog';
import { assignRole } from './role-writes';
import { writeGovernanceAuditOrThrow } from './governance-audit';
import { notificationService } from './notification-service';
import {
  supaGetDoc,
  supaListDocs,
  supaMirrorUpdate,
} from './supa-roles-reconcile-seam';
import {
  identityPrimaryFlagOn,
  primaryIdentityUpdate,
} from './supa-identity-primary';

export interface CustomRoleExpirySweepSummary {
  reminded: Array<{ uid: string; roleKey: string; stage: 't30_sent' | 't7_sent' }>;
  expiredMaterialised: Array<{
    uid: string;
    roleKey: string;
    branch: 'restored_prior' | 'removed_only' | 'escalated_banned_no_restore';
  }>;
  failures: Array<{ uid: string; roleKey: string; error: string }>;
}

type Branch = CustomRoleExpirySweepSummary['expiredMaterialised'][number]['branch'];

const DAY_MS = 86400000;

/** Millis for a stored expiresAt in any shape the store boundary admits. */
function expiryInstantMs(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.toDate === 'function') {
      try {
        const d = (rec.toDate as () => unknown).call(value);
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
      } catch {
        return null;
      }
      return null;
    }
    const seconds =
      typeof rec.seconds === 'number'
        ? rec.seconds
        : typeof rec._seconds === 'number'
          ? rec._seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof rec.nanoseconds === 'number'
          ? rec.nanoseconds
          : typeof rec._nanoseconds === 'number'
            ? rec._nanoseconds
            : 0;
      return seconds * 1000 + Math.floor(nanos / 1_000_000);
    }
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/**
 * One expiry alert to each recipient (contracts 5.2). Send failures
 * are logged, never fatal (governors parity).
 */
async function sendExpiryAlert(
  recipients: string[],
  stage: 't30_sent' | 't7_sent' | 'expired' | 'failed',
  uid: string,
  roleKey: string,
  expiresAtISO: string,
  body: string,
): Promise<void> {
  const payload = {
    type: 'custom_role_expiry_alert',
    title: `Custom role expiry alert (${stage})`,
    body,
    link: '/admin/users',
    metadata: { uid, roleKey, expiresAt: expiresAtISO },
  };
  for (const recipient of [...new Set(recipients)]) {
    try {
      await notificationService.send(recipient, payload, 'P1');
    } catch (err) {
      console.error('[custom-role-expiry-sweep] notification failed', recipient, err);
    }
  }
}

/**
 * Pre-validation for the restored_prior target (contracts 5.3): a
 * prior additional is restored only if role-writes would still accept
 * it. Catalog keys must be real and assignable; a custom slug must
 * still have a definition passing the contracts 3.2 checks (four-part
 * shape, active, chapter match against the grant doc's chapterId,
 * stored permissions free of the Reserved Powers). Anything else is
 * dropped from the restore and named in the audit - never allowed to
 * fail the whole restore. The definition read goes through the passed
 * db handle and the pure core's four-part test, the same predicates
 * the server registry adapter applies.
 */
async function priorAdditionalStillValid(
  db: Firestore,
  entry: string,
  docChapterId: string | null,
): Promise<boolean> {
  if (isCustomRoleSlug(entry)) {
    let data: Record<string, unknown> | undefined;
    try {
      // Supabase migration (ROLES G4): seam first when engaged; a
      // seam answer (including exists:false) is authoritative, a null
      // seam answer takes the base Firestore read below.
      const supaDoc = await supaGetDoc('roleDefinitions', entry);
      if (supaDoc) {
        if (!supaDoc.exists) return false;
        data = supaDoc.data;
      } else {
        const snap = await db.collection('roleDefinitions').doc(entry).get();
        if (!snap.exists) return false;
        data = snap.data() as Record<string, unknown> | undefined;
      }
    } catch {
      return false;
    }
    const def = toCustomRoleDefinition(entry, data);
    if (!def) return false;
    if (!def.isActive) return false;
    if (def.chapterId !== docChapterId) return false;
    if (
      def.permissions.some((p) =>
        (RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES as readonly string[]).includes(p),
      )
    ) {
      return false;
    }
    return true;
  }
  return isCatalogRoleKey(entry) && entry !== 'member_officer';
}

async function materialiseExpiredGrant(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
  roleKey: string,
  expiresAtISO: string,
  summary: CustomRoleExpirySweepSummary,
): Promise<void> {
  try {
    // Branch selection (contracts 5.3 + ADDENDUM R4). The roles doc
    // data comes from the scan; the ban check reads the users doc
    // (through the G4 seam when engaged; seam null = Firestore read).
    const supaUser = await supaGetDoc('users', uid);
    const isBanned = supaUser
      ? supaUser.exists && supaUser.data?.isBanned === true
      : await (async () => {
          const userSnap = await db.collection('users').doc(uid).get();
          return userSnap.exists && userSnap.data()?.isBanned === true;
        })();

    const currentRole = typeof data.role === 'string' ? data.role : null;
    const currentAdditional = stringArray(data.additionalRoles);
    const priorRole = typeof data.priorRole === 'string' ? data.priorRole : null;
    const priorAdditional = stringArray(data.priorAdditionalRoles);
    const docChapterId = typeof data.chapterId === 'string' ? data.chapterId : null;

    let branch: Branch;
    let targetRole: string;
    let targetAdditional: string[];
    const droppedPriorAdditionals: string[] = [];

    if (isBanned) {
      // Probation ban interlock: expiry is not a benefit to withhold,
      // so the slug is still removed - but restoring office to a
      // banned member is a reinstatement decision, not a sweep
      // mechanic.
      branch = 'escalated_banned_no_restore';
      targetRole = currentRole ?? 'member_basic';
      targetAdditional = currentAdditional.filter((r) => r !== roleKey);
    } else {
      const currentSet = new Set(currentAdditional);
      const priorSet = new Set([...priorAdditional, roleKey]);
      const compositionUntouched =
        currentSet.size === priorSet.size &&
        [...currentSet].every((r) => priorSet.has(r));
      // R4: the untouched test covers the primary too - a restore
      // must never stomp a later promotion.
      const primaryUntouched = priorRole === null || currentRole === priorRole;
      if (compositionUntouched && primaryUntouched) {
        branch = 'restored_prior';
        targetRole = priorRole ?? 'member_basic';
        targetAdditional = [];
        for (const entry of priorAdditional) {
          if (await priorAdditionalStillValid(db, entry, docChapterId)) {
            targetAdditional.push(entry);
          } else {
            droppedPriorAdditionals.push(entry);
          }
        }
      } else {
        branch = 'removed_only';
        targetRole = currentRole ?? 'member_basic';
        targetAdditional = currentAdditional.filter((r) => r !== roleKey);
      }
    }

    // Governance audit BEFORE any state change (contracts 5.4). If
    // it throws, the grant lands in failures and nothing changes.
    await writeGovernanceAuditOrThrow(db, {
      action: 'custom_role_grant_expired',
      actorUid: 'system',
      actorRole: 'expiry_sweep',
      targetType: 'user_role',
      targetId: uid,
      details: {
        roleKey,
        expiresAt: expiresAtISO,
        branch,
        restoredRole: targetRole,
        restoredAdditionalRoles: targetAdditional,
        droppedPriorAdditionals,
      },
    });

    // ONE assignRole call: it writes the target composition and, via
    // expiresAt: null, clears the five expiry fields in the same
    // batch. role-writes produces its own roleHistory + audit_logs
    // records from this call; they are never suppressed or duplicated.
    await assignRole(db, {
      uid,
      role: targetRole as CatalogRoleKey,
      additionalRoles: targetAdditional as CatalogRoleKey[],
      chapterId: docChapterId ?? undefined,
      actorUid: 'system',
      source: 'expiry_sweep',
      reason: `Custom role ${roleKey} grant expired at ${expiresAtISO}; prior state restored by the expiry sweep`,
      expiresAt: null,
      expiresRoleKey: roleKey,
      idempotencyKey: `expiry:${uid}:${roleKey}:${expiresAtISO}`,
    });

    summary.expiredMaterialised.push({ uid, roleKey, branch });
    await sendExpiryAlert(
      [FOUNDER_UID, uid],
      'expired',
      uid,
      roleKey,
      expiresAtISO,
      `Custom role ${roleKey} for holder ${uid} expired at ${expiresAtISO} and was materialised by the expiry sweep (${branch}).`,
    );
  } catch (err) {
    // Per-grant isolation (contracts 5.5): record the failure and
    // surface it to the Founder as an alert, never a silent drop
    // (SEC-08 point 7). One bad grant never blocks the sweep.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[custom-role-expiry-sweep] materialisation failed', uid, roleKey, err);
    summary.failures.push({ uid, roleKey, error: message });
    await sendExpiryAlert(
      [FOUNDER_UID],
      'failed',
      uid,
      roleKey,
      expiresAtISO,
      `Custom role ${roleKey} for holder ${uid} failed to materialise at expiry ${expiresAtISO}: ${message}`,
    );
  }
}

async function processCandidate(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
  roleKey: string,
  now: Date,
  summary: CustomRoleExpirySweepSummary,
): Promise<void> {
  const status = customGrantStatus(data, roleKey, now);
  if (status === 'none' || status === 'active') return;

  const expiresMs = expiryInstantMs(data.expiresAt);
  const expiresAtISO =
    expiresMs !== null ? new Date(expiresMs).toISOString() : String(data.expiresAt);

  if (status === 'expired') {
    await materialiseExpiredGrant(db, uid, data, roleKey, expiresAtISO, summary);
    return;
  }

  // 'expiring': warn stages (contracts 5.2). A grant first seen inside
  // 7 days gets T-7 only, never a late T-30 (governors parity).
  if (expiresMs === null) return;
  const daysToEnd = (expiresMs - now.getTime()) / DAY_MS;
  const stage = typeof data.expiryAlertStage === 'string' ? data.expiryAlertStage : 'none';
  const dueStage: 't30_sent' | 't7_sent' | null =
    daysToEnd <= 7 && (stage === 'none' || stage === 't30_sent')
      ? 't7_sent'
      : daysToEnd <= 30 && stage === 'none'
        ? 't30_sent'
        : null;
  if (!dueStage) return;

  await sendExpiryAlert(
    [FOUNDER_UID, uid],
    dueStage,
    uid,
    roleKey,
    expiresAtISO,
    `Custom role ${roleKey} for holder ${uid} expires at ${expiresAtISO}.`,
  );
  // Stamp ONLY the bookkeeping stage; expiresAt, the snapshot and the
  // grant composition are never mutated before the expiry instant.
  // WRITE PRIMACY (identity full build, G-ROLE-4): under
  // isSupaPrimary('roles') the pair swaps roles — the adapter update
  // is primary (loud on failure) and the Firestore update becomes
  // the best-effort reverse mirror. Non-primary: Firestore primary +
  // seam mirror, byte-identical to today.
  if (await identityPrimaryFlagOn('roles')) {
    await primaryIdentityUpdate('roles', 'roles', uid, { expiryAlertStage: dueStage });
    try {
      await db.collection('roles').doc(uid).update({ expiryAlertStage: dueStage });
    } catch (mirrorErr) {
      console.error('[custom-role-expiry-sweep] Firestore reverse mirror (stage stamp) failed after Supa primary commit:', mirrorErr);
    }
  } else {
    await db.collection('roles').doc(uid).update({ expiryAlertStage: dueStage });
    await supaMirrorUpdate('roles', uid, { expiryAlertStage: dueStage });
  }
  summary.reminded.push({ uid, roleKey, stage: dueStage });
}

export async function runCustomRoleExpirySweep(
  db: Firestore,
  now: Date,
): Promise<CustomRoleExpirySweepSummary> {
  const summary: CustomRoleExpirySweepSummary = {
    reminded: [],
    expiredMaterialised: [],
    failures: [],
  };

  // Full read of the roles collection (governors full-register read);
  // selection is in memory. No new composite index. Supabase
  // migration (ROLES G4): the read goes through the seam when engaged;
  // a null seam answer takes the base Firestore read, and a Firestore
  // read failure keeps the never-throw empty-summary behaviour below.
  // Role removals stay via assignRole (role-writes); their Supabase
  // freshness comes from the G2 chokepoint mirror inside role-writes
  // at merge, NOT from this module.
  let docs: Array<{ id: string; data: Record<string, unknown> }>;
  try {
    const supaDocs = await supaListDocs('roles');
    if (supaDocs) {
      docs = supaDocs;
    } else {
      const snap = await db.collection('roles').get();
      docs = snap.docs.map((d) => ({
        id: d.id,
        data: (d.data() ?? {}) as Record<string, unknown>,
      }));
    }
  } catch (err) {
    console.error('[custom-role-expiry-sweep] could not read roles collection', err);
    return summary;
  }

  for (const { id: uid, data } of docs) {
    // Candidate iff a pending expiry exists AND its key is a custom_
    // slug. A doc with an expiresAt but a missing/non-custom key is
    // malformed for this program (or a hand-written catalog fixture):
    // ignored entirely - no failure entry exists for it in the
    // contract summary shape.
    if (data.expiresAt === null || data.expiresAt === undefined) continue;
    const roleKey = data.expiresRoleKey;
    if (typeof roleKey !== 'string' || !isCustomRoleSlug(roleKey)) {
      console.error(
        '[custom-role-expiry-sweep] ignoring pending expiry with missing/non-custom expiresRoleKey',
        uid,
        roleKey,
      );
      continue;
    }
    try {
      await processCandidate(db, uid, data, roleKey, now, summary);
    } catch (err) {
      // Materialisation failures are already recorded (with the
      // Founder alert) inside materialiseExpiredGrant; anything
      // reaching here failed in the warn path. Isolate it the same
      // way: one bad grant never blocks the sweep (contracts 5.5).
      console.error('[custom-role-expiry-sweep] candidate failed', uid, roleKey, err);
      summary.failures.push({
        uid,
        roleKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
