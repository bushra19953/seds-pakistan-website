// Leave lifecycle engine (defect fix, 2026-10-28).
//
// The defect: approving a leave stamped the On Leave flags on the
// member's user doc immediately, even when the leave starts weeks
// later, and nothing ever cleared the flags when the leave ended.
// Assignment stayed blocked (validateUserStatus reads the flags)
// until the member happened to press Return from Leave.
//
// The fix makes the flags a function of the leave window, kept in
// step by this sweep:
//   - APPROVAL no longer stamps flags for a future leave (see the
//     leave branch of PATCH /api/admin/universal-review; it stamps
//     only when the leave has already started).
//   - THIS sweep runs daily (see /api/cron/leave-lifecycle) and:
//       ACTIVATES an approved leave once its start date arrives:
//       stamps the user doc flags exactly as approval used to.
//       COMPLETES an approved leave once its end date has passed:
//       runs the shared returnFromLeave helper with audit action
//       'leave_completed', which clears the flags, flips the
//       request to 'completed', and restores redirected work.
//       DEACTIVATES flags that were stamped early by the old
//       approval behaviour for a leave that still has not started:
//       clears them so the future leave blocks nothing until its
//       window opens and this sweep activates it.
//   - Manual Return from Leave is untouched and keeps working for
//     any active leave through returnFromLeave, the single owner
//     of return state changes. This module never duplicates its
//     restore logic; it only decides WHEN a leave ends.
//
// Idempotency: activation checks the user doc first (flags already
// stamped for this request means no writes), completion moves the
// request out of 'approved' so a later run never sees it again,
// and deactivation only fires while the wrong flags are present.
// A second run over the same data writes nothing.
//
// Modes follow the cron repair convention (reconcile-roles,
// resync-events): 'dry-run' is the default and performs every read
// and classification with ZERO writes; 'repair' applies.
//
// Reads: approved leave requests come through the hr-leave seam
// when the leave surface is on (Supa-first, mirroring how
// leave-return.ts reads a request), with a bounded Firestore
// query as the fallback. One user doc read per candidate request.
//
// No em dashes in this file. Plain ASCII only.

import * as admin from 'firebase-admin';
import { returnFromLeave } from '@/lib/server/leave-return';
import {
  identityPrimaryFlagOn,
  primaryIdentitySet,
  primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';
import {
  isLeaveSupaEnabled,
  mirrorLeaveAuditSet,
  mirrorLeaveRequestUpdate,
  tryListLeaveRequests,
} from '@/lib/supa-seams/hr-leave';
import {
  karachiTodayString,
  leaveWindowPhase,
  normalizeLeaveDateString,
} from '@/lib/server/leave-dates';

export const LEAVE_LIFECYCLE_ACTOR_ID = 'system:leave-lifecycle';

// Hard bound on the approved-request scan, per run. Leave volume
// is small; the cap exists so a data anomaly cannot turn the
// sweep into an unbounded collection read.
export const MAX_APPROVED_LEAVE_REQUESTS = 500;

export type LeaveLifecycleMode = 'dry-run' | 'repair';

export interface LeaveLifecycleAction {
  leaveRequestId: string;
  uid: string;
  applied: boolean;
}

export interface LeaveLifecycleSkip {
  leaveRequestId: string;
  reason: string;
}

export interface LeaveLifecycleReport {
  mode: LeaveLifecycleMode;
  todayKarachi: string;
  scanned: number;
  truncated: boolean;
  future: number;
  alreadyActive: number;
  activated: LeaveLifecycleAction[];
  completed: LeaveLifecycleAction[];
  deactivated: LeaveLifecycleAction[];
  skipped: LeaveLifecycleSkip[];
}

interface ApprovedLeaveRequest {
  id: string;
  data: Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// Same resolution contract as resolveLeaveRequesterUid in the
// universal-review route: userId wins for leave, with the legacy
// carrier fields as fallbacks.
function resolveRequesterUid(data: Record<string, unknown>): string | null {
  const candidates = [
    data.userId,
    data.requesterId,
    data.user_id,
    data.submittedBy,
    data.assigneeId,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const first = candidate.find((v) => typeof v === 'string' && v.trim() !== '');
      if (first) return first;
    } else if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return null;
}

function normalizeOptionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

async function listApprovedLeaveRequests(
  db: admin.firestore.Firestore,
): Promise<ApprovedLeaveRequest[]> {
  if (isLeaveSupaEnabled()) {
    const result = await tryListLeaveRequests({
      where: [['status', '==', 'approved']],
      limit: MAX_APPROVED_LEAVE_REQUESTS,
    });
    if (result.status === 'ok') {
      return result.value.map((doc) => {
        const { id, ...rest } = doc as Record<string, unknown> & { id: string };
        return { id: String(id), data: rest };
      });
    }
    // 'disabled' or 'error': fall through to the Firestore read,
    // the seam's standing fallback contract.
  }
  const snap = await db
    .collection('leave_requests')
    .where('status', '==', 'approved')
    .limit(MAX_APPROVED_LEAVE_REQUESTS)
    .get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    data: (doc.data() || {}) as Record<string, unknown>,
  }));
}

interface UserLeaveState {
  exists: boolean;
  flagsOn: boolean;
  leaveRequestId: string | null;
}

async function readUserLeaveState(
  db: admin.firestore.Firestore,
  uid: string,
): Promise<UserLeaveState> {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    return { exists: false, flagsOn: false, leaveRequestId: null };
  }
  const data = snap.data() || {};
  return {
    exists: true,
    flagsOn: data.isOnVacation === true || data.vacationMode === true,
    leaveRequestId: isNonEmptyString(data.leaveRequestId)
      ? data.leaveRequestId.trim()
      : null,
  };
}

/**
 * Stamp the On Leave flags for a request whose window has opened.
 * The payload is byte-identical to the one the approval branch
 * writes for an already-started leave, and the write path mirrors
 * it: identity primary first (under users primacy), then the
 * Firestore batch as the reverse mirror, then the audit mirror.
 */
async function activateLeave(
  db: admin.firestore.Firestore,
  request: ApprovedLeaveRequest,
  uid: string,
): Promise<void> {
  const startDate = request.data.startDate ?? request.data.start_date ?? null;
  const endDate = request.data.endDate ?? request.data.end_date ?? null;
  const coveringOfficerId = normalizeOptionalString(
    request.data.coveringOfficerId ?? request.data.covering_officer_id,
  );

  const flagPayload: Record<string, unknown> = {
    isOnVacation: true,
    vacationMode: true,
    coveringOfficerId,
    vacationStartDate: startDate,
    vacationEndDate: endDate,
    leaveRequestId: request.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (await identityPrimaryFlagOn('users')) {
    await primaryIdentitySet('users', 'users', uid, flagPayload, { merge: true });
  }

  const batch = db.batch();
  batch.set(db.collection('users').doc(uid), flagPayload, { merge: true });
  const auditRef = db.collection('leave_audit').doc();
  const auditData: Record<string, unknown> = {
    actorId: LEAVE_LIFECYCLE_ACTOR_ID,
    targetUid: uid,
    action: 'leave_activated',
    leaveRequestId: request.id,
    startDate,
    endDate,
    coveringOfficerId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
  batch.set(auditRef, auditData);
  await batch.commit();

  await mirrorLeaveAuditSet(auditRef.id, auditData);
}

/**
 * Clear flags that the old approval behaviour stamped for a leave
 * whose window has not opened yet. Only the flag fields and the
 * leaveRequestId pointer are touched (same shape as the user
 * update in returnFromLeave); the request stays 'approved' and
 * this sweep activates it when its start date arrives.
 */
async function deactivatePrematureFlags(
  db: admin.firestore.Firestore,
  request: ApprovedLeaveRequest,
  uid: string,
): Promise<void> {
  const userUpdate: Record<string, unknown> = {
    isOnVacation: false,
    vacationMode: false,
    leaveRequestId: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (await identityPrimaryFlagOn('users')) {
    await primaryIdentityUpdate('users', 'users', uid, userUpdate);
  }

  const batch = db.batch();
  batch.update(db.collection('users').doc(uid), userUpdate);
  const auditRef = db.collection('leave_audit').doc();
  const auditData: Record<string, unknown> = {
    actorId: LEAVE_LIFECYCLE_ACTOR_ID,
    targetUid: uid,
    action: 'leave_deactivated',
    leaveRequestId: request.id,
    startDate: request.data.startDate ?? request.data.start_date ?? null,
    endDate: request.data.endDate ?? request.data.end_date ?? null,
    coveringOfficerId: normalizeOptionalString(
      request.data.coveringOfficerId ?? request.data.covering_officer_id,
    ),
    reason:
      'On Leave flags were set before the leave start date; cleared by the lifecycle sweep. The sweep activates the leave when its window opens.',
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
  batch.set(auditRef, auditData);
  await batch.commit();

  await mirrorLeaveAuditSet(auditRef.id, auditData);
}

/**
 * Complete a request whose window has ended while the member's
 * flags belong to a DIFFERENT leave (back-to-back leaves, or a
 * manual state the return helper must not clobber). Only the
 * request status flips; flags, tasks, and the other leave are
 * left exactly as they are.
 */
async function completeRequestStatusOnly(
  db: admin.firestore.Firestore,
  request: ApprovedLeaveRequest,
  uid: string,
): Promise<void> {
  const requestUpdate: Record<string, unknown> = {
    status: 'completed',
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    completedBy: LEAVE_LIFECYCLE_ACTOR_ID,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const batch = db.batch();
  batch.update(db.collection('leave_requests').doc(request.id), requestUpdate);
  const auditRef = db.collection('leave_audit').doc();
  const auditData: Record<string, unknown> = {
    action: 'leave_completed',
    actorId: LEAVE_LIFECYCLE_ACTOR_ID,
    actorName: null,
    targetUid: uid,
    leaveRequestId: request.id,
    restoredCount: 0,
    heldClearedCount: 0,
    reason:
      'Leave window ended while a different leave held the member flags; status completed without touching flags.',
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
  batch.set(auditRef, auditData);
  await batch.commit();

  await mirrorLeaveRequestUpdate(request.id, requestUpdate);
  await mirrorLeaveAuditSet(auditRef.id, auditData);
}

export async function runLeaveLifecycle(
  db: admin.firestore.Firestore,
  options: { mode: LeaveLifecycleMode; now?: Date },
): Promise<LeaveLifecycleReport> {
  const mode = options.mode;
  const apply = mode === 'repair';
  const today = karachiTodayString(options.now ?? new Date());

  const requests = await listApprovedLeaveRequests(db);
  const truncated = requests.length >= MAX_APPROVED_LEAVE_REQUESTS;
  const sorted = [...requests].sort((a, b) => a.id.localeCompare(b.id));

  const report: LeaveLifecycleReport = {
    mode,
    todayKarachi: today,
    scanned: sorted.length,
    truncated,
    future: 0,
    alreadyActive: 0,
    activated: [],
    completed: [],
    deactivated: [],
    skipped: [],
  };

  // Completions run before activations so a back-to-back pair
  // (one leave ends, the next starts today) settles in one pass:
  // the old leave completes and frees the flags, then the new
  // leave activates against the cleared user doc.
  const ended: ApprovedLeaveRequest[] = [];
  const inWindow: ApprovedLeaveRequest[] = [];
  const future: ApprovedLeaveRequest[] = [];
  for (const request of sorted) {
    const phase = leaveWindowPhase(request.data.startDate, request.data.endDate, today);
    if (phase === 'unknown') {
      report.skipped.push({
        leaveRequestId: request.id,
        reason: 'unparseable start or end date',
      });
    } else if (phase === 'ended') {
      ended.push(request);
    } else if (phase === 'in-window') {
      inWindow.push(request);
    } else {
      future.push(request);
    }
  }

  for (const request of ended) {
    const uid = resolveRequesterUid(request.data);
    if (!uid) {
      report.skipped.push({ leaveRequestId: request.id, reason: 'no requester resolved' });
      continue;
    }
    const state = await readUserLeaveState(db, uid);
    if (!state.exists) {
      report.skipped.push({ leaveRequestId: request.id, reason: 'requester user doc not found' });
      continue;
    }
    const flaggedForOther =
      state.leaveRequestId !== null && state.leaveRequestId !== request.id;
    if (apply) {
      if (flaggedForOther) {
        await completeRequestStatusOnly(db, request, uid);
      } else {
        await returnFromLeave(db, {
          uid,
          leaveRequestId: request.id,
          actorId: LEAVE_LIFECYCLE_ACTOR_ID,
          auditAction: 'leave_completed',
        });
      }
    }
    report.completed.push({ leaveRequestId: request.id, uid, applied: apply });
  }

  for (const request of inWindow) {
    const uid = resolveRequesterUid(request.data);
    if (!uid) {
      report.skipped.push({ leaveRequestId: request.id, reason: 'no requester resolved' });
      continue;
    }
    const state = await readUserLeaveState(db, uid);
    if (!state.exists) {
      report.skipped.push({ leaveRequestId: request.id, reason: 'requester user doc not found' });
      continue;
    }
    if (state.flagsOn && state.leaveRequestId === request.id) {
      report.alreadyActive += 1;
      continue;
    }
    if (state.flagsOn) {
      report.skipped.push({
        leaveRequestId: request.id,
        reason:
          state.leaveRequestId !== null
            ? 'member flags are held by a different leave request'
            : 'member flags are on without a leave request pointer',
      });
      continue;
    }
    if (apply) {
      await activateLeave(db, request, uid);
    }
    report.activated.push({ leaveRequestId: request.id, uid, applied: apply });
  }

  for (const request of future) {
    report.future += 1;
    const uid = resolveRequesterUid(request.data);
    if (!uid) continue;
    const state = await readUserLeaveState(db, uid);
    if (!state.exists) continue;
    // Residual drift from the old approval behaviour: flags were
    // stamped for this request before its window opened. Clear
    // them; activation happens when the window arrives.
    if (state.flagsOn && state.leaveRequestId === request.id) {
      if (apply) {
        await deactivatePrematureFlags(db, request, uid);
      }
      report.deactivated.push({ leaveRequestId: request.id, uid, applied: apply });
    }
  }

  return report;
}

// Re-exported for callers that only need the window math.
export { karachiTodayString, normalizeLeaveDateString };
