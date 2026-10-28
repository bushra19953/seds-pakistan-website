// Target file: src/lib/server/leave-return.ts
// Shared server helper for return from leave. Single owner of all
// return-from-leave state changes. Do not duplicate this logic in
// any route. Routes only authenticate, authorize, validate their
// own gate, resolve ids, call this helper, and then handle their
// own route-specific response and notification.
//
// Callers:
//   - POST /api/user/post-vacation (member self-return, auditAction 'leave_returned')
//   - PATCH /api/admin/universal-review with action 'revoke'
//     (admin revoke of an approved leave, auditAction 'leave_revoked')
//   - The leave lifecycle cron (src/lib/server/leave-lifecycle.ts),
//     which completes an approved leave whose end date has passed
//     with auditAction 'leave_completed' and the cron actor id.
//   - POST /api/admin/users/restore-workload (follow-up migration:
//     replace its inline restore block with a call to this helper,
//     keeping its existing canManageUsers gate. Do not keep two
//     restore implementations.)
//
// The helper writes no notifications. Callers that need a
// notification write it themselves after the helper returns, so
// notification copy stays with the caller that knows the context
// (self-return vs admin revoke).
//
// No em dashes in this file. Plain ASCII only.

import * as admin from 'firebase-admin';
import {
    identityPrimaryFlagOn,
    primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';

import {
    isLeaveSupaEnabled,
    mirrorLeaveAuditSet,
    mirrorLeaveRequestUpdate,
    tryGetLeaveRequestRaw,
} from '@/lib/supa-seams/hr-leave';

export type LeaveReturnAuditAction =
    | 'leave_returned'
    | 'leave_revoked'
    | 'leave_completed';

export interface ReturnFromLeaveOptions {
    uid: string;
    // Optional. When omitted, the helper falls back to
    // users/{uid}.leaveRequestId. When given and the user doc
    // carries a different leaveRequestId, the helper throws,
    // because the user is on leave for a different request and
    // clearing flags for this request would be wrong.
    leaveRequestId?: string;
    actorId: string;
    actorName?: string;
    // Default 'leave_returned'. Admin revoke passes 'leave_revoked'.
    auditAction?: LeaveReturnAuditAction;
    // Optional reason. Revoke callers pass the admin notes here.
    // Self-return callers omit it. Stored on the leave request
    // (as revocationReason for revoke, as returnReason otherwise)
    // and on the leave_audit entry.
    reason?: string;
}

export interface ReturnFromLeaveResult {
    restoredCount: number;
    heldClearedCount: number;
    alreadyReturned: boolean;
    leaveRequestId: string | null;
    requestCompleted: boolean;
    targetUid: string;
}

// Task statuses that are eligible for restore. Both spellings of
// in-progress are included. See NOTES.md for why both are required.
// Tasks in any other status (for example 'completed', 'approved',
// 'overdue', 'cancelled') are NOT restored by this helper, even
// when they still carry redirectedFrom. That is deliberate: the
// helper only hands back live work. See the overdue note in NOTES.md.
export const RESTORABLE_TASK_STATUSES = [
    'pending',
    'locked',
    'in_progress',
    'in-progress',
] as const;

const RESTORABLE_STATUS_SET = new Set<string>(RESTORABLE_TASK_STATUSES);

// Firestore batch limit is 500 writes. Each restored task costs
// 2 writes (task update + activity entry). Each held task costs
// 2 writes (task update + activity entry). The user update,
// request update, and audit entry cost 3 writes. 150 tasks per
// batch keeps the largest batch well under the limit.
const TASKS_PER_BATCH = 150;

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

export async function returnFromLeave(
    db: admin.firestore.Firestore,
    options: ReturnFromLeaveOptions,
): Promise<ReturnFromLeaveResult> {
    const { uid, actorId } = options;
    const auditAction: LeaveReturnAuditAction = options.auditAction || 'leave_returned';
    const reason = isNonEmptyString(options.reason) ? options.reason.trim() : null;

    if (!isNonEmptyString(uid)) {
        throw new Error('returnFromLeave: uid is required');
    }
    if (!isNonEmptyString(actorId)) {
        throw new Error('returnFromLeave: actorId is required');
    }

    // 1. Read the user doc. It is the source of truth for the
    // on-leave flags and the fallback leaveRequestId.
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new Error('returnFromLeave: user record not found');
    }
    const userData = userSnap.data() || {};
    const isOnLeave = userData.isOnVacation === true || userData.vacationMode === true;

    // 2. Resolve the effective leave request id. Explicit option
    // wins, otherwise use the id stamped on the user doc.
    const userLeaveRequestId = isNonEmptyString(userData.leaveRequestId)
        ? userData.leaveRequestId.trim()
        : null;
    const explicitLeaveRequestId = isNonEmptyString(options.leaveRequestId)
        ? options.leaveRequestId.trim()
        : null;
    const effectiveLeaveRequestId = explicitLeaveRequestId || userLeaveRequestId;

    // Defensive guard: never clear flags for request A when the
    // user doc says the active leave is request B. Overlapping
    // leaves are rejected at apply time, so this should not
    // happen, but a mismatch means the data is inconsistent and
    // silently clearing would strand the real leave.
    if (
        explicitLeaveRequestId !== null &&
        userLeaveRequestId !== null &&
        explicitLeaveRequestId !== userLeaveRequestId
    ) {
        throw new Error(
            'returnFromLeave: user is on leave for a different leave request',
        );
    }

    // 3. Read the leave request, when one resolves. A missing doc
    // is a dangling pointer (older or manual flow). It does not
    // fail the return. The flags and the workload are still
    // restored, and requestCompleted is reported as false.
    let requestRef: admin.firestore.DocumentReference | null = null;
    let requestData: Record<string, unknown> | null = null;
    let requestExists = false;
    if (effectiveLeaveRequestId !== null) {
        requestRef = db.collection('leave_requests').doc(effectiveLeaveRequestId);
        // Supa-first read of the leave-owned doc when the surface is ON;
        // disabled flag or any adapter error falls back to Firestore.
        // Only .status is consumed below, so no timestamp conversion is
        // needed on this path (the raw reader is used deliberately).
        let supaReadDone = false;
        if (isLeaveSupaEnabled()) {
            const supaResult = await tryGetLeaveRequestRaw(effectiveLeaveRequestId);
            if (supaResult.status === 'ok') {
                supaReadDone = true;
                requestExists = supaResult.value !== null;
                if (requestExists && supaResult.value) {
                    const { id: _supaId, ...rest } = supaResult.value;
                    void _supaId;
                    requestData = rest as Record<string, unknown>;
                }
            }
        }
        if (!supaReadDone) {
            const requestSnap = await requestRef.get();
            requestExists = requestSnap.exists;
            if (requestExists) {
                requestData = (requestSnap.data() || {}) as Record<string, unknown>;
            }
        }
    }
    const requestStatus =
        requestData !== null && typeof requestData.status === 'string'
            ? requestData.status
            : null;
    const requestIsApproved = requestStatus === 'approved';
    const requestAlreadyCompleted = requestStatus === 'completed';

    // 4. Find the work to restore. The redirected query has NO
    // status filter in Firestore. Filtering happens in code, so
    // both spellings of in-progress are covered and a future
    // status spelling cannot silently hide a redirected task
    // from the query. The held query finds tasks still held
    // with the user because no covering officer was assigned.
    const redirectedSnap = await db
        .collection('tasks')
        .where('redirectedFrom', '==', uid)
        .get();
    const redirectedCandidates = redirectedSnap.docs.filter((doc) => {
        const status = doc.data()?.status;
        return typeof status === 'string' && RESTORABLE_STATUS_SET.has(status);
    });

    const heldSnap = await db
        .collection('tasks')
        .where('assigneeId', '==', uid)
        .where('leaveHold', '==', true)
        .get();
    // Bug 3 (single-doc): a co-assignee lives only in the assigneeIds
    // array, so held docs must also match that way. Single-field query
    // (automatic index, no composite needed); leaveHold is matched in
    // memory to keep the query index-free.
    const heldCoSnap = await db
        .collection('tasks')
        .where('assigneeIds', 'array-contains', uid)
        .get();
    const heldSeenIds = new Set(heldSnap.docs.map((doc) => doc.id));
    const heldCoDocs = heldCoSnap.docs.filter(
        (doc) => !heldSeenIds.has(doc.id) && (doc.data() as any)?.leaveHold === true
    );
    const heldDocs = [...heldSnap.docs, ...heldCoDocs];
    const redirectedIds = new Set(redirectedCandidates.map((doc) => doc.id));
    // A task that was both redirected and held is handled once,
    // by the restore branch, which also clears its hold fields.
    const heldCandidates = heldDocs.filter((doc) => !redirectedIds.has(doc.id));

    // 5. Idempotency guard. A second call changes nothing and
    // writes nothing, including no second audit entry, when ALL
    // of these hold: the user is not flagged on leave, there is
    // no approved request left to complete, and no redirected
    // or held tasks remain. Note the guard is not just
    // "flags are clear": when flags are still set but the
    // request is already completed (partial earlier return),
    // the call proceeds and finishes the cleanup. And when
    // flags are clear but redirected tasks remain (orphan
    // repair), the call proceeds and restores them.
    const nothingToDo =
        !isOnLeave &&
        (effectiveLeaveRequestId === null || !requestExists || requestAlreadyCompleted) &&
        redirectedCandidates.length === 0 &&
        heldCandidates.length === 0;
    if (nothingToDo) {
        return {
            restoredCount: 0,
            heldClearedCount: 0,
            alreadyReturned: true,
            leaveRequestId: effectiveLeaveRequestId,
            requestCompleted: requestAlreadyCompleted,
            targetUid: uid,
        };
    }

    const restoredCount = redirectedCandidates.length;
    const heldClearedCount = heldCandidates.length;
    const willCompleteRequest = requestExists && requestIsApproved;
    const requestCompleted = requestAlreadyCompleted || willCompleteRequest;

    // 6. Build the user update. Both flags are always cleared
    // together. coveringOfficerId and the vacation dates are
    // KEPT for history. leaveRequestId is deleted only when it
    // matches the request being closed, so a different active
    // leave is never unlinked by mistake.
    const userUpdate: Record<string, unknown> = {
        isOnVacation: false,
        vacationMode: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (
        userLeaveRequestId !== null &&
        (effectiveLeaveRequestId === null || userLeaveRequestId === effectiveLeaveRequestId)
    ) {
        userUpdate.leaveRequestId = admin.firestore.FieldValue.delete();
    }

    // 7. Build the leave request update, only when the doc
    // exists and is still approved. A pending, rejected,
    // cancelled, or already completed request is left untouched.
    // This helper never flips a non-approved request to
    // completed.
    let requestUpdate: Record<string, unknown> | null = null;
    if (willCompleteRequest && requestRef !== null) {
        requestUpdate = {
            status: 'completed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (auditAction === 'leave_revoked') {
            requestUpdate.revokedAt = admin.firestore.FieldValue.serverTimestamp();
            requestUpdate.revokedBy = actorId;
            requestUpdate.revocationReason = reason;
        } else if (auditAction === 'leave_completed') {
            // System completion at the end of the leave window
            // (lifecycle cron). Distinct stamps from a manual
            // return so reports can tell the two apart.
            requestUpdate.completedAt = admin.firestore.FieldValue.serverTimestamp();
            requestUpdate.completedBy = actorId;
        } else {
            requestUpdate.returnedAt = admin.firestore.FieldValue.serverTimestamp();
            requestUpdate.returnedBy = actorId;
            requestUpdate.returnReason = reason;
        }
    }

    // 8. Commit in chunks. The first chunk carries the user
    // update, the request update, and the audit entry, plus the
    // first slice of task work. Later chunks carry only task
    // work. The audit entry is written exactly once, in the
    // first chunk, and only when this call actually changed
    // something (guaranteed by the nothingToDo guard above).
    const allTaskDocs = [...redirectedCandidates, ...heldCandidates];
    const taskChunks: admin.firestore.QueryDocumentSnapshot[][] = [];
    for (let i = 0; i < allTaskDocs.length; i += TASKS_PER_BATCH) {
        taskChunks.push(allTaskDocs.slice(i, i + TASKS_PER_BATCH));
    }
    // Even with zero task docs there is still one chunk, so the
    // core writes (user, request, audit) are committed.
    if (taskChunks.length === 0) {
        taskChunks.push([]);
    }

    // Captured in chunk 0 for the Supabase dual-write mirror below.
    let capturedAudit: { id: string; data: Record<string, unknown> } | null = null;

    // WRITE PRIMACY (identity full build, G-USER-6, U-28): under
    // isSupaPrimary('users') the vacation-flag clear lands on the
    // adapter FIRST (loud); the chunk-0 batch below keeps its native
    // user update as the reverse mirror (the leave-owned docs in the
    // same chunks keep their existing leave-surface mirrors,
    // un-duplicated — H-01). Non-primary: byte-identical.
    if (await identityPrimaryFlagOn('users')) {
        await primaryIdentityUpdate('users', 'users', uid, userUpdate);
    }

    for (let chunkIndex = 0; chunkIndex < taskChunks.length; chunkIndex += 1) {
        const batch = db.batch();
        const chunk = taskChunks[chunkIndex];

        if (chunkIndex === 0) {
            batch.update(userRef, userUpdate);
            if (requestUpdate !== null && requestRef !== null) {
                batch.update(requestRef, requestUpdate);
            }
            const auditRef = db.collection('leave_audit').doc();
            const auditData: Record<string, unknown> = {
                action: auditAction,
                actorId,
                actorName: isNonEmptyString(options.actorName)
                    ? options.actorName
                    : null,
                targetUid: uid,
                leaveRequestId: effectiveLeaveRequestId,
                restoredCount,
                heldClearedCount,
                reason,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            };
            batch.set(auditRef, auditData);
            capturedAudit = { id: auditRef.id, data: auditData };
        }

        for (const taskDoc of chunk) {
            const taskData = taskDoc.data() || {};
            const isRedirected = redirectedIds.has(taskDoc.id);
            if (isRedirected) {
                const taskUpdate: Record<string, unknown> = {
                    assigneeId: uid,
                    redirectedFrom: admin.firestore.FieldValue.delete(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                // Clear hold fields on the same write when the
                // restored task also carries a hold, instead of
                // leaving a stale hold behind.
                if (taskData.leaveHold === true) {
                    taskUpdate.leaveHold = false;
                    taskUpdate.leaveHoldReason = admin.firestore.FieldValue.delete();
                }
                batch.update(taskDoc.ref, taskUpdate);
                const activityRef = taskDoc.ref.collection('activity').doc();
                batch.set(activityRef, {
                    type: 'reassign',
                    userId: actorId,
                    data: {
                        previousAssigneeId: taskData.assigneeId ?? null,
                        newAssigneeId: uid,
                        reason:
                            auditAction === 'leave_revoked'
                                ? 'Leave revoked by admin, workload returned'
                                : auditAction === 'leave_completed'
                                  ? 'Leave period ended, workload returned'
                                  : 'Return from leave, workload restored',
                    },
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            } else {
                // Held task: assignee stays the same, only the
                // hold is cleared so the task becomes
                // processable again.
                batch.update(taskDoc.ref, {
                    leaveHold: false,
                    leaveHoldReason: admin.firestore.FieldValue.delete(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                const activityRef = taskDoc.ref.collection('activity').doc();
                batch.set(activityRef, {
                    type: 'leave_hold_cleared',
                    userId: actorId,
                    data: {
                        assigneeId: uid,
                        reason:
                            auditAction === 'leave_revoked'
                                ? 'Leave revoked by admin, hold cleared'
                                : auditAction === 'leave_completed'
                                  ? 'Leave period ended, hold cleared'
                                  : 'Return from leave, hold cleared',
                    },
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }

        await batch.commit();
    }

    // Dual-write mirror (leave-owned docs only): the completed leave
    // request and the leave_audit entry. Users, tasks and task activity
    // are cross-collection and stay Firestore-only (other clusters).
    // Mirror failures never throw; Firestore has already committed.
    if (requestUpdate !== null && effectiveLeaveRequestId !== null) {
        await mirrorLeaveRequestUpdate(effectiveLeaveRequestId, requestUpdate);
    }
    if (capturedAudit !== null) {
        await mirrorLeaveAuditSet(capturedAudit.id, capturedAudit.data);
    }

    return {
        restoredCount,
        heldClearedCount,
        alreadyReturned: false,
        leaveRequestId: effectiveLeaveRequestId,
        requestCompleted,
        targetUid: uid,
    };
}
