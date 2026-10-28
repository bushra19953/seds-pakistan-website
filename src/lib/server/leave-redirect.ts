// Target file: src/lib/server/leave-redirect.ts
// Server helper for the redirect-out step of an approved leave.
// Single owner of the approval-time task handover: when a leave is
// approved with a covering officer named, the member's live tasks
// whose deadlines fall inside the leave window are reassigned to
// the covering officer and stamped with redirectedFrom, which is
// exactly what returnFromLeave (src/lib/server/leave-return.ts)
// reads when the member comes back. The MVP shipped the restore
// half only; this file is the missing write half. Do not invent a
// parallel handover model: the fields, the restorable status list,
// and the activity entry shape here mirror leave-return.ts on
// purpose, so approval-redirect and return-restore stay one
// journey with one owner per half.
//
// Callers:
//   - PATCH /api/admin/universal-review, leave approval branch:
//     queued during the review loop and executed after the review
//     batch commits, with validateUserStatus passed as the
//     eligibility check so the platform's own assignment gate
//     decides whether the covering officer may receive work.
//
// Safety contract: a task is redirected ONLY when the covering
// officer assignment would pass the platform's own validation.
// Anything else is skipped, untouched, with a recorded reason:
//   - the task is not in a restorable status (overdue included:
//     the return helper deliberately never restores those, so a
//     redirect here would strand the task with the officer)
//   - the task deadline is outside the leave window, or the task
//     has no usable deadline (window membership is judged by the
//     shared rule in leave-exemption.ts, so the redirect window
//     and the penalty-exemption window can never drift apart)
//   - the task is already redirected
//   - the task is a workflow step and the covering officer is not
//     in workflowParticipantIds (the tasks API rejects such an
//     assignee with a 400; never force it here)
//   - the covering officer cannot receive work at all (on leave
//     themselves, banned, or missing): every otherwise-eligible
//     task is skipped with that reason
// When no covering officer is named the caller does not call this
// helper at all: short leaves keep their tasks with the member,
// and the caller notes that in its result and log instead.
//
// Every run (including one that redirects nothing) writes one
// leave_audit entry with action 'leave_tasks_redirected' carrying
// the redirected ids and the per-task skip reasons, so the
// handover decision is auditable after the fact.
//
// No em dashes in this file. Plain ASCII only.

import * as admin from 'firebase-admin';
import { RESTORABLE_TASK_STATUSES } from '@/lib/server/leave-return';
import { isExemptFromDeadlinePenalty } from '@/lib/server/leave-exemption';
import { mirrorLeaveAuditSet } from '@/lib/supa-seams/hr-leave';

export type LeaveRedirectSkipReason =
    | 'already_redirected'
    | 'status_not_restorable'
    | 'no_deadline'
    | 'deadline_outside_window'
    | 'covering_officer_not_workflow_participant'
    | 'covering_officer_unavailable';

export interface LeaveRedirectSkip {
    taskId: string;
    reason: LeaveRedirectSkipReason;
    detail: string;
}

export interface LeaveRedirectEligibility {
    isValid: boolean;
    isOnVacation?: boolean;
    error?: string;
}

export interface RedirectTasksForLeaveOptions {
    memberUid: string;
    coveringOfficerId: string;
    leaveRequestId: string;
    // Raw leave window bounds as stored on the leave request
    // (date-only strings, ISO strings, or Timestamps). Judged with
    // the leave-exemption parser, never re-parsed here.
    windowStart: unknown;
    windowEnd: unknown;
    actorId: string;
    // Platform assignment validation for the covering officer.
    // The universal-review caller passes validateUserStatus from
    // src/lib/server/user-status.ts. When omitted, a db-based
    // check with the same semantics is used (missing user, banned,
    // or either vacation flag set means the officer cannot
    // receive work).
    checkAssigneeEligible?: (
        uid: string,
    ) => Promise<LeaveRedirectEligibility>;
}

export interface RedirectTasksForLeaveResult {
    redirectedTaskIds: string[];
    skipped: LeaveRedirectSkip[];
    coveringOfficerAvailable: boolean;
}

const RESTORABLE_STATUS_SET = new Set<string>(RESTORABLE_TASK_STATUSES);

// Firestore batch limit is 500 writes. Each redirected task costs
// 2 writes (task update + activity entry), the same accounting
// leave-return.ts uses, so the same 150-task chunk size applies.
const TASKS_PER_BATCH = 150;

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

// Default eligibility check, used when the caller does not inject
// one. Mirrors validateUserStatus (src/lib/server/user-status.ts):
// a missing user, a banned user, or a user with either vacation
// flag set cannot receive assignments. Never throws; an
// evaluation failure means unavailable, never forced through.
async function defaultCheckAssigneeEligible(
    db: admin.firestore.Firestore,
    uid: string,
): Promise<LeaveRedirectEligibility> {
    try {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) {
            return { isValid: false, error: 'User does not exist' };
        }
        const data = snap.data() || {};
        if (data.isBanned) {
            return { isValid: false, error: 'User is banned' };
        }
        if (data.isOnVacation || data.vacationMode) {
            return {
                isValid: false,
                isOnVacation: true,
                error: 'User is currently on vacation',
            };
        }
        return { isValid: true, isOnVacation: false };
    } catch (error: any) {
        return { isValid: false, error: error?.message || 'Eligibility check failed' };
    }
}

export async function redirectTasksForLeave(
    db: admin.firestore.Firestore,
    options: RedirectTasksForLeaveOptions,
): Promise<RedirectTasksForLeaveResult> {
    const { memberUid, coveringOfficerId, leaveRequestId, actorId } = options;

    if (!isNonEmptyString(memberUid)) {
        throw new Error('redirectTasksForLeave: memberUid is required');
    }
    if (!isNonEmptyString(coveringOfficerId)) {
        throw new Error('redirectTasksForLeave: coveringOfficerId is required');
    }
    if (!isNonEmptyString(leaveRequestId)) {
        throw new Error('redirectTasksForLeave: leaveRequestId is required');
    }
    if (!isNonEmptyString(actorId)) {
        throw new Error('redirectTasksForLeave: actorId is required');
    }

    // 1. Judge the covering officer ONCE with the platform's own
    // assignment validation. An unavailable officer fails every
    // otherwise-eligible task below; the redirect never forces an
    // assignment the tasks API would reject.
    const eligibility = options.checkAssigneeEligible
        ? await options.checkAssigneeEligible(coveringOfficerId)
        : await defaultCheckAssigneeEligible(db, coveringOfficerId);
    const coveringOfficerAvailable = eligibility.isValid === true;
    const unavailableDetail =
        eligibility.error || 'Covering officer cannot receive assignments';

    // 2. Find the member's tasks. The query has NO status filter;
    // filtering happens in code, exactly like the return helper,
    // so both spellings of in-progress are covered and a status
    // spelling cannot silently hide a task from the handover.
    // Only the primary assignee field is redirected: the return
    // helper restores assigneeId, so a task where the member is
    // only a co-assignee (assigneeIds) is never stamped here.
    const tasksSnap = await db
        .collection('tasks')
        .where('assigneeId', '==', memberUid)
        .get();

    // Window membership is judged by the shared exemption rule:
    // a synthetic on-leave user carrying this leave's window.
    // exempt === true means the deadline falls inside the window.
    const windowProbeUser = {
        isOnVacation: true,
        vacationStartDate: options.windowStart,
        vacationEndDate: options.windowEnd,
        leaveRequestId,
    };

    const redirectedDocs: admin.firestore.QueryDocumentSnapshot[] = [];
    const skipped: LeaveRedirectSkip[] = [];

    for (const taskDoc of tasksSnap.docs) {
        const taskData = taskDoc.data() || {};

        if (isNonEmptyString(taskData.redirectedFrom)) {
            skipped.push({
                taskId: taskDoc.id,
                reason: 'already_redirected',
                detail: `Task already redirected from ${String(taskData.redirectedFrom)}`,
            });
            continue;
        }

        const status = typeof taskData.status === 'string' ? taskData.status : '';
        if (!RESTORABLE_STATUS_SET.has(status)) {
            skipped.push({
                taskId: taskDoc.id,
                reason: 'status_not_restorable',
                detail: `Task status '${status || 'unknown'}' is not restorable on return, so it is not redirected`,
            });
            continue;
        }

        const windowCheck = isExemptFromDeadlinePenalty(windowProbeUser, taskData);
        if (!windowCheck.exempt) {
            skipped.push({
                taskId: taskDoc.id,
                reason: windowCheck.reason.startsWith('No usable deadline')
                    ? 'no_deadline'
                    : 'deadline_outside_window',
                detail: windowCheck.reason,
            });
            continue;
        }

        // Workflow steps carry workflowParticipantIds and the
        // tasks API requires the assignee to be one of them.
        if (Array.isArray(taskData.workflowParticipantIds) && taskData.workflowParticipantIds.length > 0) {
            const participantSet = new Set(
                taskData.workflowParticipantIds.map((v: any) => String(v)),
            );
            if (!participantSet.has(coveringOfficerId)) {
                skipped.push({
                    taskId: taskDoc.id,
                    reason: 'covering_officer_not_workflow_participant',
                    detail: 'Covering officer is not in workflowParticipantIds for this workflow step',
                });
                continue;
            }
        }

        if (!coveringOfficerAvailable) {
            skipped.push({
                taskId: taskDoc.id,
                reason: 'covering_officer_unavailable',
                detail: unavailableDetail,
            });
            continue;
        }

        redirectedDocs.push(taskDoc);
    }

    // 3. Commit the redirects in chunks. Each task gets the two
    // writes the return journey expects: the task update
    // (assigneeId moves to the officer, redirectedFrom stamps the
    // member) and a 'reassign' activity entry shaped exactly like
    // the one leave-return.ts writes on restore.
    for (let i = 0; i < redirectedDocs.length; i += TASKS_PER_BATCH) {
        const chunk = redirectedDocs.slice(i, i + TASKS_PER_BATCH);
        const batch = db.batch();
        for (const taskDoc of chunk) {
            batch.update(taskDoc.ref, {
                assigneeId: coveringOfficerId,
                redirectedFrom: memberUid,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            const activityRef = taskDoc.ref.collection('activity').doc();
            batch.set(activityRef, {
                type: 'reassign',
                userId: actorId,
                data: {
                    previousAssigneeId: memberUid,
                    newAssigneeId: coveringOfficerId,
                    reason: 'Leave approved, workload redirected to covering officer',
                    leaveRequestId,
                },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
        await batch.commit();
    }

    // 4. Record the handover in leave_audit: what moved, and every
    // skip with its reason, so the decision survives the request.
    const auditRef = db.collection('leave_audit').doc();
    const auditData: Record<string, unknown> = {
        action: 'leave_tasks_redirected',
        actorId,
        targetUid: memberUid,
        leaveRequestId,
        coveringOfficerId,
        coveringOfficerAvailable,
        redirectedCount: redirectedDocs.length,
        redirectedTaskIds: redirectedDocs.map((doc) => doc.id),
        skipped,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    await auditRef.set(auditData);

    // Dual-write mirror of the leave-owned audit entry, the same
    // mirror leave-return.ts performs. Mirror failures never
    // throw; Firestore has already committed.
    await mirrorLeaveAuditSet(auditRef.id, auditData);

    return {
        redirectedTaskIds: redirectedDocs.map((doc) => doc.id),
        skipped,
        coveringOfficerAvailable,
    };
}
