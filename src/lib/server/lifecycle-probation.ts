/**
 * lifecycle-probation.ts - Phase 2 Section D.10: probation restore.
 *
 * The failure this fixes (audit B3/B4): issue-warning demoted the member
 * and clear-probation at expiry only zeroed warningCount - the demoted
 * role was gone permanently and the pre-demotion role was never stored
 * anywhere durable.
 *
 * Capture (in the SAME transaction as the demotion, by the warning
 * issuance path - Workstream E's route calls captureProbationRestore or
 * writes the identical doc): probation_restores/{warningId} records the
 * pre-warning role read SERVER-SIDE. A client-supplied role parameter is
 * ignored and its presence audit-logged as a data-quality note.
 *
 * Expiry (processProbationRestore - ONE function invoked from both
 * clear-probation and the governance cron's retry stanza, so behaviour
 * cannot diverge):
 *  - restoreMode is the SNAPSHOT taken at capture (Plan Decision 13,
 *    second half: ship default 'reappoint'; a later flag flip does not
 *    change a running probation's terms);
 *  - 'reappoint': NO role write; a re-appointment task goes to the
 *    current holder(s) of the catalog appointer role (vacant -> National
 *    Membership Director -> Founder);
 *  - 'auto': eligibility is re-checked AT RESTORE TIME (membership floor
 *    with a fresh schedule_3_2_c Consent, cadet probation, seat
 *    occupancy, role still in catalog) and the D.2 guard runs as the
 *    restoring authority; any failure falls through to the reappoint
 *    branch with the reason stamped, never an overwrite;
 *  - a banned target is NOT restored and NOT tasked: the record escalates
 *    (restoring office to a banned member is a reinstatement decision,
 *    not a probation mechanic). The cron retry evaluates banned targets
 *    explicitly so their records are decided, not stranded.
 * This module NEVER writes warningCount (the derived counter is
 * Phase 0 / Workstream E's; D removes the legacy zeroing from the
 * restore path by simply not doing it).
 */

import { FOUNDER_UID } from '@/lib/roles';
import type { ProbationRestoreDoc } from '@/types/lifecycle';
import {
  createLifecycleTask,
  getDecidedConsent,
  getLifecycleSettings,
  isCadetInProbation,
  membershipClassOf,
  resolveRoleHolders,
  resolveRoleHoldersInChapter,
  resolveSeatedGovernors,
  sendLifecycleNotification,
  writeGovernanceAuditOrThrow,
} from './lifecycle-adapters';
import { LifecycleError, toMillis, withLifecycleStore } from './lifecycle-ratification';
import { checkLifecycleGuards } from './lifecycle-guard';
import {
  getAppointerEntryIncludingSupplementary,
  type AppointerMapEntry,
} from './lifecycle-appointer-map';
import { FOUNDER_APPOINTER_KEY } from '@/types/lifecycle';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface CaptureProbationRestoreParams {
  warningId: string;
  userId: string;
  demotedToRoleKey: string;
  probationEndsAt: Date;
  /**
   * The pre-warning role, read by the caller inside the demotion
   * transaction immediately before the demote write. When omitted, the
   * helper reads roles/{userId} itself (still server-side).
   */
  preWarningRoleKey?: string | null;
  preWarningChapterSlug?: string | null;
  /** A role value that arrived from the client, if any. NEVER used. */
  clientSuppliedRoleKey?: string | null;
}

export async function captureProbationRestore(
  db: Db,
  params: CaptureProbationRestoreParams,
): Promise<string> {
  const ref = db.collection('probation_restores').doc(params.warningId);
  const existing = await ref.get();
  if (existing?.exists) return params.warningId;

  let preWarningRoleKey = params.preWarningRoleKey ?? null;
  let preWarningChapterSlug = params.preWarningChapterSlug ?? null;
  if (preWarningRoleKey === null) {
    const roleSnap = await db.collection('roles').doc(params.userId).get();
    const roleData = roleSnap?.exists ? (roleSnap.data() ?? {}) : {};
    preWarningRoleKey = roleData.roleKey ?? roleData.role ?? roleData.currentRoleKey ?? null;
    if (preWarningChapterSlug === null) {
      preWarningChapterSlug =
        typeof roleData.chapterSlug === 'string' ? roleData.chapterSlug : null;
    }
  }

  if (params.clientSuppliedRoleKey) {
    // Spoof surface (T13): the client value is ignored; its presence is
    // a data-quality note in the governance audit, nothing more.
    await writeGovernanceAuditOrThrow(db, {
      action: 'probation_restore_client_role_ignored',
      warningId: params.warningId,
      userId: params.userId,
      clientSuppliedRoleKey: params.clientSuppliedRoleKey,
      serverCapturedRoleKey: preWarningRoleKey,
    });
  }

  const settings = await getLifecycleSettings(db);
  const doc: Record<string, unknown> = {
    id: params.warningId,
    warningId: params.warningId,
    userId: params.userId,
    preWarningRoleKey,
    preWarningChapterSlug,
    demotedToRoleKey: params.demotedToRoleKey,
    probationEndsAt: params.probationEndsAt,
    status: 'pending',
    restoreMode: settings.probationRestoreMode === 'auto' ? 'auto' : 'reappoint',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await ref.set(doc);
  return params.warningId;
}

// ---------------------------------------------------------------------------
// Expiry processing
// ---------------------------------------------------------------------------

export interface ProcessProbationRestoreResult {
  warningId: string;
  status: string;
  acted: boolean;
  mode?: string;
  fellBackToReappointReason?: string | null;
  escalationReason?: string | null;
  taskId?: string | null;
}

async function resolveAppointerHolderUids(
  db: Db,
  entry: AppointerMapEntry | undefined,
  chapterSlug: string | null,
): Promise<string[]> {
  if (!entry || entry.appointingRoleKeys.length === 0) return [];
  const appointerKey = entry.appointingRoleKeys[0];
  if (appointerKey === FOUNDER_APPOINTER_KEY) return [FOUNDER_UID];
  if (appointerKey === 'board_of_governors') {
    const seated = await resolveSeatedGovernors(db);
    return seated.map((g) => g.uid);
  }
  if (entry.chapterScoped && chapterSlug) {
    return resolveRoleHoldersInChapter(db, appointerKey, chapterSlug);
  }
  return resolveRoleHolders(db, appointerKey);
}

async function taskReappointment(
  db: Db,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: Record<string, any>,
  fellBackToReappointReason: string | null,
): Promise<ProcessProbationRestoreResult> {
  const warningId = String(doc.warningId);
  const userId = String(doc.userId);
  const roleKey = (doc.preWarningRoleKey as string | null) ?? null;
  const entry = roleKey ? getAppointerEntryIncludingSupplementary(roleKey) : undefined;
  let assignees = await resolveAppointerHolderUids(db, entry, doc.preWarningChapterSlug ?? null);
  if (assignees.length === 0) {
    assignees = await resolveRoleHolders(db, 'national_membership_director');
  }
  if (assignees.length === 0) assignees = [FOUNDER_UID];

  const userSnap = await db.collection('users').doc(userId).get();
  const userData = userSnap?.exists ? (userSnap.data() ?? {}) : {};
  const userName =
    (typeof userData.displayName === 'string' && userData.displayName) ||
    (typeof userData.name === 'string' && userData.name) ||
    userId;
  const roleLabel = roleKey ?? 'unknown role';
  const taskId = await createLifecycleTask(db, {
    title: `Re-appointment decision: ${userName}, ${roleLabel} (probation ended)`,
    body:
      `Probation ended for ${userName}. Pre-warning role: ${roleLabel}. ` +
      `Demoted-to role: ${String(doc.demotedToRoleKey ?? 'unknown')}. Warning id: ${warningId}. ` +
      `User record: /admin/users/${userId}. Vacancies: /admin/lifecycle/vacancies. ` +
      `Decide re-appointment as the catalog appointer for ${roleLabel}.`,
    assigneeUids: assignees,
    relatedUserId: userId,
    relatedWarningId: warningId,
  });
  const ref = db.collection('probation_restores').doc(warningId);
  await ref.update({
    status: 'reappointment_tasked',
    ...(fellBackToReappointReason ? { fellBackToReappointReason } : {}),
    updatedAt: new Date(),
  });
  await writeGovernanceAuditOrThrow(db, {
    action: 'probation_restore_reappointment_tasked',
    warningId,
    userId,
    roleKey,
    taskId,
    assigneeUids: assignees,
    fellBackToReappointReason,
  });
  await sendLifecycleNotification(db, userId, 'probation_cleared', {
    title: 'Probation cleared',
    body: 'Your probation period has ended. Re-appointment to your former role is with the appointer for that role.',
    warningId,
  });
  return {
    warningId,
    status: 'reappointment_tasked',
    acted: true,
    mode: doc.restoreMode,
    fellBackToReappointReason,
    taskId,
  };
}

export async function processProbationRestore(
  db: Db,
  warningId: string,
  now: Date = new Date(),
): Promise<ProcessProbationRestoreResult> {
  const ref = db.collection('probation_restores').doc(warningId);
  const snap = await ref.get();
  if (!snap?.exists) {
    throw new LifecycleError('NOT_FOUND', `Probation restore ${warningId} not found.`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: Record<string, any> = snap.data() ?? {};
  if (doc.status !== 'pending') {
    return { warningId, status: String(doc.status), acted: false };
  }
  if (toMillis(doc.probationEndsAt) > now.getTime()) {
    return { warningId, status: 'pending', acted: false };
  }
  const userId = String(doc.userId);
  const userSnap = await db.collection('users').doc(userId).get();
  const userData = userSnap?.exists ? (userSnap.data() ?? {}) : {};

  // Ban interlock: decided explicitly (escalated), never silently skipped.
  if (userData.isBanned === true) {
    await ref.update({
      status: 'escalated',
      escalationReason: 'target_banned',
      updatedAt: new Date(),
    });
    await writeGovernanceAuditOrThrow(db, {
      action: 'probation_restore_escalated',
      warningId,
      userId,
      escalationReason: 'target_banned',
    });
    await sendLifecycleNotification(db, FOUNDER_UID, 'probation_restore_escalated', {
      title: 'Probation restore escalated: member is banned',
      body: `The probation restore for ${userId} (warning ${warningId}) cannot proceed because the member is banned. Restoration would be a reinstatement decision.`,
      warningId,
      userId,
    });
    return { warningId, status: 'escalated', acted: true, escalationReason: 'target_banned' };
  }

  const mode = doc.restoreMode === 'auto' ? 'auto' : 'reappoint';
  if (mode === 'reappoint') {
    return taskReappointment(db, doc, null);
  }

  // -- 'auto': eligibility re-check at restore time (never capture time).
  const roleKey = (doc.preWarningRoleKey as string | null) ?? null;
  if (!roleKey) {
    await ref.update({
      status: 'escalated',
      escalationReason: 'no_pre_warning_role',
      updatedAt: new Date(),
    });
    await writeGovernanceAuditOrThrow(db, {
      action: 'probation_restore_escalated',
      warningId,
      userId,
      escalationReason: 'no_pre_warning_role',
    });
    return { warningId, status: 'escalated', acted: true, escalationReason: 'no_pre_warning_role' };
  }
  const entry = getAppointerEntryIncludingSupplementary(roleKey);
  if (!entry) {
    // T13: role no longer in the catalog -> task to the Membership
    // Director (taskReappointment's fallback chain), audit code recorded.
    await writeGovernanceAuditOrThrow(db, {
      action: 'probation_restore_role_not_in_catalog',
      code: 'ROLE_NO_LONGER_IN_CATALOG',
      warningId,
      userId,
      roleKey,
    });
    return taskReappointment(db, doc, 'role_no_longer_in_catalog');
  }
  if (!entry.probationRestorable) {
    return taskReappointment(db, doc, 'role_not_restorable');
  }
  const chapterSlug = (doc.preWarningChapterSlug as string | null) ?? null;
  const holders = entry.chapterScoped && chapterSlug
    ? await resolveRoleHoldersInChapter(db, roleKey, chapterSlug)
    : await resolveRoleHolders(db, roleKey);
  if (
    entry.seatBound &&
    entry.holderCap !== null &&
    holders.length >= entry.holderCap &&
    !holders.includes(userId)
  ) {
    // Seat taken meanwhile: convert to a task, never overwrite (T13).
    return taskReappointment(db, doc, 'seat_occupied');
  }
  const membershipClass = await membershipClassOf(db, userId);
  const consent = await getDecidedConsent(db, userId, roleKey);
  const guard = checkLifecycleGuards({
    targetUid: userId,
    roleKey,
    action: 'appoint',
    chapterSlug: chapterSlug ?? undefined,
    // The restore executes as the Founder/system authority so the guard
    // enforces exactly the hard fails + occupancy (D.10); appointer-match
    // is not re-litigated for a restoration.
    actorUid: FOUNDER_UID,
    actorRoleKeys: [FOUNDER_APPOINTER_KEY],
    actorChapterSlug: chapterSlug ?? undefined,
    subjectMembershipClass: membershipClass,
    subjectIsCadetInProbation: await isCadetInProbation(db, userId),
    founderOverride: true,
    consentLookup: () =>
      consent ? { id: consent.id, subjectUid: userId, roleKey, status: consent.status } : null,
    seatOccupancy: { holderUids: holders, cap: entry.holderCap },
  });
  if (!guard.allowed) {
    return taskReappointment(db, doc, `guard_denied:${guard.code}`);
  }

  // Restore via the write path (roles + users mirror), never warningCount.
  await withLifecycleStore(db, async (store) => {
    const roleRef = db.collection('roles').doc(userId);
    const roleSnap = await store.get(roleRef);
    const roleWrite: Record<string, unknown> = {
      role: roleKey,
      roleKey,
      currentRoleKey: roleKey,
      ...(chapterSlug ? { chapterSlug } : {}),
      updatedAt: new Date(),
    };
    if (roleSnap?.exists) await store.update(roleRef, roleWrite);
    else await store.set(roleRef, roleWrite);
    const userRef = db.collection('users').doc(userId);
    const freshUser = await store.get(userRef);
    if (freshUser?.exists) {
      await store.update(userRef, { role: roleKey, updatedAt: new Date() });
    }
  });
  await ref.update({ status: 'restored_automatic', updatedAt: new Date() });
  await writeGovernanceAuditOrThrow(db, {
    action: 'probation_role_restored',
    warningId,
    userId,
    roleKey,
    chapterSlug,
  });
  await sendLifecycleNotification(db, userId, 'probation_cleared', {
    title: 'Probation cleared: role restored',
    body: `Your probation period has ended and your role as ${roleKey} has been restored.`,
    warningId,
    roleKey,
  });
  return { warningId, status: 'restored_automatic', acted: true, mode };
}

// ---------------------------------------------------------------------------
// Cron retry stanza + one-time legacy backfill (D.10)
// ---------------------------------------------------------------------------

export interface ProbationRetryResult {
  scanned: number;
  acted: number;
  skipped: number;
  errors: number;
}

export async function retryProbationRestores(
  db: Db,
  now: Date = new Date(),
): Promise<ProbationRetryResult> {
  const result: ProbationRetryResult = { scanned: 0, acted: 0, skipped: 0, errors: 0 };
  const snap = await db.collection('probation_restores').get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs: any[] = snap?.docs ?? [];
  for (const docSnap of docs) {
    const data = typeof docSnap.data === 'function' ? docSnap.data() : null;
    if (!data || data.status !== 'pending') continue;
    if (toMillis(data.probationEndsAt) > now.getTime()) continue;
    result.scanned += 1;
    try {
      const r = await processProbationRestore(db, docSnap.id, now);
      if (r.acted) result.acted += 1;
      else result.skipped += 1;
    } catch (err) {
      result.errors += 1;
      console.error('[lifecycle] probation restore retry failed for', docSnap.id, err);
    }
  }
  return result;
}

/**
 * One-time backfill for probations already running at ship date (D.10):
 * derives the pre-warning role from the role-change audit trail where an
 * entry records fromRole; where none exists the record is created
 * escalated immediately - the engine never invents a role to restore.
 */
export async function backfillLegacyProbationRestores(
  db: Db,
  now: Date = new Date(),
): Promise<{ created: number; escalated: number; skipped: number }> {
  const result = { created: 0, escalated: 0, skipped: 0 };
  const settings = await getLifecycleSettings(db);
  const usersSnap = await db.collection('users').get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userDocs: any[] = usersSnap?.docs ?? [];
  const auditSnap = await db.collection('audit_logs').get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auditDocs: any[] = auditSnap?.docs ?? [];
  for (const userDoc of userDocs) {
    const data = typeof userDoc.data === 'function' ? userDoc.data() : null;
    if (!data || data.isOnProbation !== true || !data.probationEndsAt) continue;
    const uid = userDoc.id as string;
    const warningId =
      (typeof data.activeWarningId === 'string' && data.activeWarningId) ||
      (typeof data.warningId === 'string' && data.warningId) ||
      `legacy_${uid}`;
    const ref = db.collection('probation_restores').doc(warningId);
    const existing = await ref.get();
    if (existing?.exists) {
      result.skipped += 1;
      continue;
    }
    let preWarningRoleKey: string | null = null;
    let bestMs = -1;
    for (const auditDoc of auditDocs) {
      const a = typeof auditDoc.data === 'function' ? auditDoc.data() : null;
      if (!a) continue;
      const target = a.targetUid ?? a.userId ?? null;
      if (target !== uid) continue;
      if (typeof a.fromRole !== 'string' || !a.fromRole) continue;
      const ms = toMillis(a.createdAt);
      if (ms >= bestMs) {
        bestMs = ms;
        preWarningRoleKey = a.fromRole;
      }
    }
    const escalated = preWarningRoleKey === null;
    await ref.set({
      id: warningId,
      warningId,
      userId: uid,
      preWarningRoleKey,
      preWarningChapterSlug: null,
      demotedToRoleKey: (data.role as string) ?? 'member_basic',
      probationEndsAt: data.probationEndsAt,
      status: escalated ? 'escalated' : 'pending',
      ...(escalated ? { escalationReason: 'legacy_no_pre_warning_role' } : {}),
      restoreMode: settings.probationRestoreMode === 'auto' ? 'auto' : 'reappoint',
      createdAt: now,
      updatedAt: now,
    } satisfies Record<string, unknown>);
    result.created += 1;
    if (escalated) result.escalated += 1;
  }
  return result;
}

export type { ProbationRestoreDoc };
