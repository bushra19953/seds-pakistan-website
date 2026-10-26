import { admin, getDb } from '@/lib/server/firebase-admin';
import { taskTimeToMs } from '@/lib/deadline-fairness';
import { isExemptFromDeadlinePenalty } from '@/lib/server/leave-exemption';
import { isSupaPrimary } from '@/lib/supa/flags';
import { applyPointsAwardViaSupa, type PointsAwardInput } from '@/lib/supa/gamification';
import {
    mirrorNotificationCreate,
    userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

export async function executeGamificationTransaction(
    taskId: string,
    updatesToApply: any,
    taskBefore: any,
    actorUid: string
) {
    const db = getDb();
    if (!db) throw new Error('Firestore not initialized');

    // C-07 (Supabase cutover, Option A): when gamification is
    // Supa-primary, the ledger-bearing points awards computed inside
    // this transaction are NOT written to Firestore. They are queued
    // here and claimed AFTER the transaction commits via the
    // apply_points_award RPC, whose deterministic ledger id
    // (pa_<taskId>_<userId>_<action>) IS the double-pay guard on the
    // Supa side. Primary OFF (the default until the flip) the queue
    // stays empty and every write below is byte-identical to the
    // pre-cutover behavior.
    const supaPrimary = isSupaPrimary('gamification');
    const pendingAwards: PointsAwardInput[] = [];
    // GAP-N1 residual #1: the THREE notification write sites in this
    // file (per-assignee approval, delegatee, workflow handoff) queue
    // their payloads here; they are mirrored to Supabase only AFTER
    // the transaction commits, in every flag mode (the mirror itself
    // is gated by the notifications surface inside the seam).
    const notifMirrors: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];

    const result = await db.runTransaction(async (t) => {
        // A Firestore transaction callback may be retried; only the
        // attempt that actually commits may flush its queues.
        pendingAwards.length = 0;
        notifMirrors.length = 0;
        // ==========================================
        // 1. ALL READS (Must precede any writes)
        // ==========================================
        const taskRef = db.collection('tasks').doc(taskId);
        const tTaskSnap = await t.get(taskRef);
        if (!tTaskSnap.exists) throw new Error('Task not found in transaction');
        const tTaskBefore = tTaskSnap.data() || {};

        if (tTaskBefore.status === 'completed' || tTaskBefore.status === 'approved') {
            throw new Error('Task already marked as completed idempotently.');
        }

        // Determine assignee(s). Drop null/empty/falsy entries so a malformed
        // assignee list can never reach doc() / ledger lookups downstream.
        const assigneeIds: string[] = (Array.isArray(tTaskBefore.assigneeIds)
            ? tTaskBefore.assigneeIds
            : tTaskBefore.assigneeId ? [String(tTaskBefore.assigneeId)] : [])
            .filter((uid: any) => typeof uid === 'string' ? uid.trim() !== '' : Boolean(uid))
            .map((uid: any) => String(uid));

        // Assignment Type (Individual vs Collective). Prefer current camelCase,
        // fall back to legacy snake_case fields on older task docs.
        const assignmentType = tTaskBefore.assignmentType || tTaskBefore.assignment_type || 'individual'; // collective points route to chapters
        const chapterId = tTaskBefore.chapterId || tTaskBefore.assignee_id; // If collective, assignee_id acts as chapter_id

        // Point Math (Split vs Duplicate). The approver authorized amount in
        // updatesToApply.pointsAwarded (same field the universal-review and
        // submissions routes already use) overrides the task base points
        // when present and a valid finite number. Otherwise base points apply.
        const authorizedPoints = updatesToApply?.pointsAwarded;
        const basePoints = typeof authorizedPoints === 'number' && Number.isFinite(authorizedPoints)
            ? authorizedPoints
            : (typeof tTaskBefore.points === 'number' ? tTaskBefore.points : (tTaskBefore.base_points || 0));
        const distributionMode = tTaskBefore.pointDistributionMode || tTaskBefore.point_distribution_mode || 'duplicate';
        let pointsToAward = basePoints;
        if (distributionMode === 'split' && assigneeIds.length > 0 && assignmentType === 'individual') {
            pointsToAward = Math.floor(basePoints / assigneeIds.length);
        }

        // Double dipping lock: Check points_ledger
        const ledgerLocks = await Promise.all(
            assigneeIds.map(uid =>
                t.get(db.collection('points_ledger')
                    .where('task_id', '==', taskId)
                    .where('user_id', '==', uid)
                    .where('action', '==', 'COMPLETION')
                    .limit(1)
                )
            )
        );
        const alreadyReceived = ledgerLocks.some(snap => !snap.empty);
        // One already-paid assignee must not veto the others: pay only the
        // assignees with no COMPLETION ledger entry for this task.
        const unpaidAssigneeIds = assigneeIds.filter((uid, i) => ledgerLocks[i].empty);

        // Parent Task Gamification Rollup & Sibling Reads
        let parentRef = null;
        let parentData = null;
        let allSiblingsCompleted = false;

        const parentId = tTaskBefore.parent_task_id;
        if (parentId) {
            parentRef = db.collection('tasks').doc(parentId);
            const pSnap = await t.get(parentRef);
            if (pSnap.exists) {
                parentData = pSnap.data() || {};

                const siblingsSnap = await t.get(db.collection('tasks').where('parent_task_id', '==', parentId));
                // Check if all siblings (ignoring the current task being processed) are completed
                allSiblingsCompleted = siblingsSnap.docs.every(doc =>
                    doc.id === taskId || doc.data().status === 'completed' || doc.data().status === 'approved'
                );
            }
        }

        // Leave exemption reads (must precede all writes). For every
        // unpaid assignee and for the delegatee, check whether the task
        // deadline falls inside their approved leave window. The result
        // maps uid -> { exempt, leaveRequestId }. Missing user docs and
        // non-exempt users map to exempt: false.
        const delegationForLeave = tTaskBefore.delegation;
        const hasDelegationForLeave = delegationForLeave && delegationForLeave.status === 'accepted' && delegationForLeave.delegatedTo;
        const leaveExemptByUid = new Map<string, { exempt: boolean; leaveRequestId: string | null }>();
        const leaveCheckUids = [...new Set([...unpaidAssigneeIds, ...(hasDelegationForLeave ? [String(delegationForLeave.delegatedTo)] : [])])];
        for (const leaveUid of leaveCheckUids) {
            try {
                const leaveUserSnap = await t.get(db.collection('users').doc(leaveUid));
                const leaveCheck = isExemptFromDeadlinePenalty(
                    leaveUserSnap.exists ? (leaveUserSnap.data() || {}) : {},
                    tTaskBefore
                );
                leaveExemptByUid.set(leaveUid, { exempt: leaveCheck.exempt, leaveRequestId: leaveCheck.leaveRequestId ?? null });
            } catch {
                leaveExemptByUid.set(leaveUid, { exempt: false, leaveRequestId: null });
            }
        }
        const leaveExemptFor = (uid: string) => leaveExemptByUid.get(uid) || { exempt: false, leaveRequestId: null };

        // Auto-Handoff Next Step Read (if workflow)
        let nextStepRef = null;
        let nextStepData = null;
        let nextStepAssignee = null;
        const wfId = tTaskBefore.workflowId ? String(tTaskBefore.workflowId) : null;
        // Guard sequenceIndex: missing, empty, or non-numeric values are
        // NOT final. Only a finite number (or a non-empty numeric string)
        // counts as a valid sequence index.
        const rawSeq = tTaskBefore.sequenceIndex;
        const seq = (typeof rawSeq === 'number' && Number.isFinite(rawSeq))
            || (typeof rawSeq === 'string' && rawSeq.trim() !== '' && Number.isFinite(Number(rawSeq)))
            ? Number(rawSeq) : undefined;
        if (wfId && typeof seq === 'number') {
            const nextQuery = await t.get(db.collection('tasks')
                .where('workflowId', '==', wfId)
                .where('sequenceIndex', '==', seq + 1)
                .limit(1)
            );
            if (!nextQuery.empty) {
                nextStepRef = nextQuery.docs[0].ref;
                nextStepData = nextQuery.docs[0].data();
                nextStepAssignee = String(nextStepData.assigneeId || '');
            }
        }

        // Roles and Badge Reads
        const completionBadgeId = updatesToApply.completionBadgeId || tTaskBefore.completionBadgeId;
        const stepSpecificBadgeId = tTaskBefore.stepSpecificBadgeId;
        const finalWorkflowCompletionBadgeId = tTaskBefore.finalWorkflowCompletionBadgeId;

        // ==========================================
        // 2. ALL WRITES
        // ==========================================
        // Determine on-time status
        let completedOnTime = false;
        let deadlineDate: Date | null = null;
        const d: any = tTaskBefore.deadline;
        if (d) {
            if (typeof d?.toDate === 'function') deadlineDate = (d as admin.firestore.Timestamp).toDate();
            else if (typeof d === 'string') deadlineDate = new Date(d);
            else if (d instanceof Date) deadlineDate = d;
        }
        // Also check individualDeadline for workflow steps (more specific than task deadline)
        const id: any = (tTaskBefore as any).individualDeadline;
        if (id) {
            let individualDate: Date | null = null;
            if (typeof id?.toDate === 'function') individualDate = (id as admin.firestore.Timestamp).toDate();
            else if (typeof id === 'string') individualDate = new Date(id);
            else if (id instanceof Date) individualDate = id;
            if (individualDate) deadlineDate = individualDate;
        }
        const completedAtTs = admin.firestore.Timestamp.now();
        // DEADLINE FAIRNESS (founder rule, 2026-10-26): lateness is
        // judged on the SUBMISSION instant when the task carries a
        // server-stamped submittedAt. Time a submission spends waiting
        // for review belongs to the reviewer, so an approval landing
        // after the deadline must not turn an on-time submission late
        // or cost the assignee the deadline penalty. Completions with
        // no submission record (direct/admin completions) keep the
        // completion-instant judgment below.
        const submittedMs = taskTimeToMs((tTaskBefore as any).submittedAt);
        const judgedAtMs = submittedMs ?? taskTimeToMs(completedAtTs) ?? Date.now();
        if (deadlineDate) {
            completedOnTime = judgedAtMs <= deadlineDate.getTime();
        }

        // DEADLINE PENALTY: Deduct penalty points if completed late
        const penaltyPoints = typeof tTaskBefore.penaltyPoints === 'number' ? tTaskBefore.penaltyPoints : 0;
        const isLate = deadlineDate ? !completedOnTime : false;
        const penaltyToApply = isLate && penaltyPoints > 0 ? penaltyPoints : 0;

        // Update Task to completed
        const taskWritePayload = {
            ...updatesToApply,
            completedAt: completedAtTs,
            isCurrentStep: false,
            updatedAt: completedAtTs,
            // One canonical terminal spelling: approvals always land on
            // 'completed'. The legacy 'approved' spelling is honored by
            // readers only; it is never written again.
            status: 'completed'
        };
        t.update(taskRef, taskWritePayload);

        // Apply individual distributions
        // Check for accepted delegation — if present, split points between delegator and delegatee
        const delegation = tTaskBefore.delegation;
        const hasDelegation = delegation && delegation.status === 'accepted' && delegation.delegatedTo;

        if (assignmentType === 'individual' && unpaidAssigneeIds.length > 0) {
            unpaidAssigneeIds.forEach(uid => {
                // If this task was delegated, the original assignee gets pointsKept instead of full points
                const effectivePoints = hasDelegation
                    ? (typeof delegation.pointsKept === 'number' ? delegation.pointsKept : pointsToAward)
                    : pointsToAward;

                // Approved-leave exemption for THIS assignee: a
                // completion whose deadline falls inside their approved
                // leave window is NOT late for penalty purposes. Full
                // points, no late counter, ledger flagged leave_exempt.
                const assigneeLeave = leaveExemptFor(uid);
                const assigneePenaltyToApply = assigneeLeave.exempt ? 0 : penaltyToApply;
                const assigneeCompletedLate = isLate && !assigneeLeave.exempt;

                // Apply deadline penalty: deduct from awarded points if late
                const finalPoints = Math.max(0, effectivePoints - assigneePenaltyToApply);

                const userRef = db.collection('users').doc(uid);
                const taskHoursWorked = typeof updatesToApply.hoursWorked === 'number'
                    ? updatesToApply.hoursWorked
                    : (typeof tTaskBefore.hoursWorked === 'number' ? tTaskBefore.hoursWorked : 0);
                // C-07 guard swap: under Supa-primary, an assignee whose
                // award would write a ledger row (points paid, or a
                // penalty that wiped them out) is claimed by the RPC
                // post-commit instead of the Firestore writes below.
                // The zero-points / zero-penalty case writes no ledger
                // row today, so it keeps the Firestore counter writes
                // exactly (the RPC would invent a ledger claim).
                const awardViaSupa = supaPrimary && (finalPoints > 0 || assigneePenaltyToApply > 0);
                if (awardViaSupa) {
                    // The RPC covers points, the ledger row, the
                    // completion counters, hours and badges. Only the
                    // workload release stays here: tasksAssignedCount
                    // is not a gamification counter and the RPC does
                    // not touch it.
                    t.set(userRef, {
                        tasksAssignedCount: admin.firestore.FieldValue.increment(-1),
                    }, { merge: true });
                    pendingAwards.push({
                        taskId,
                        userId: uid,
                        action: finalPoints > 0 ? 'COMPLETION' : 'PENALTY',
                        reason: finalPoints > 0
                            ? (hasDelegation ? 'task_completion_delegator' : 'task_completion')
                            : 'task_completion_penalty',
                        points: finalPoints,
                        countCompletion: true,
                        // Leave-exempt late = neither on-time nor late
                        // (null), exactly as the counters below behave.
                        onTime: completedOnTime ? true : (assigneeCompletedLate ? false : null),
                        hoursWorked: taskHoursWorked,
                        badgeIds: [completionBadgeId, stepSpecificBadgeId]
                            .filter((b): b is string => typeof b === 'string' && !!b),
                    });
                } else {
                const uUpdates: any = {
                    lastTaskCompletedAt: completedAtTs,
                    tasksCompletedCount: admin.firestore.FieldValue.increment(1),
                    // The task is no longer outstanding, so release it from the
                    // denormalized workload counter. The workload API counts
                    // active tasks live; this keeps the display counter truthful.
                    tasksAssignedCount: admin.firestore.FieldValue.increment(-1),
                };
                // A leave-exempt late completion counts as neither
                // late nor on-time, so the late rate is not inflated by
                // approved leave. A non-late completion still counts
                // on-time normally.
                if (completedOnTime) uUpdates.tasksCompletedOnTimeCount = admin.firestore.FieldValue.increment(1);
                if (assigneeCompletedLate) uUpdates.tasksCompletedLateCount = admin.firestore.FieldValue.increment(1);

                if (finalPoints > 0) {
                    uUpdates.total_points = admin.firestore.FieldValue.increment(finalPoints);
                    uUpdates.points = admin.firestore.FieldValue.increment(finalPoints); // legacy fallback

                    // Double-dipping lock ledger entry. When the
                    // assignee is leave-exempt the entry is still a
                    // COMPLETION and carries leave_exempt plus the leave
                    // request id, so the exemption is auditable.
                    const ledgerRef = db.collection('points_ledger').doc();
                    t.set(ledgerRef, {
                        user_id: uid,
                        task_id: taskId,
                        reason: hasDelegation ? 'task_completion_delegator' : 'task_completion',
                        action: 'COMPLETION',
                        points_awarded: finalPoints,
                        points_before_penalty: effectivePoints,
                        penalty_applied: assigneePenaltyToApply,
                        completed_late: assigneeCompletedLate,
                        ...(assigneeLeave.exempt ? { leave_exempt: true, leaveRequestId: assigneeLeave.leaveRequestId } : {}),
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                } else if (assigneePenaltyToApply > 0) {
                    // Penalty wiped out all points — still log it
                    const ledgerRef = db.collection('points_ledger').doc();
                    t.set(ledgerRef, {
                        user_id: uid,
                        task_id: taskId,
                        reason: 'task_completion_penalty',
                        action: 'PENALTY',
                        points_awarded: 0,
                        points_before_penalty: effectivePoints,
                        penalty_applied: assigneePenaltyToApply,
                        completed_late: true,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                }

                if (taskHoursWorked > 0) uUpdates.totalHoursWorked = admin.firestore.FieldValue.increment(taskHoursWorked);

                t.set(userRef, uUpdates, { merge: true });

                // Badges
                if (completionBadgeId) {
                    t.set(userRef, { badges: admin.firestore.FieldValue.arrayUnion(completionBadgeId) }, { merge: true });
                }
                if (stepSpecificBadgeId) {
                    t.set(userRef, { badges: admin.firestore.FieldValue.arrayUnion(stepSpecificBadgeId) }, { merge: true });
                }
                }

                // Notifications — GAP-N1 site 1 of 3 (per-assignee approval)
                const nref = db.collection('users').doc(uid).collection('notifications').doc();
                const assigneeNotifData = {
                    type: 'submission_feedback',
                    title: assigneeCompletedLate ? 'Task Approved (Late) ⚠️' : 'Task Approved! 🎉',
                    body: `"${tTaskBefore.title || 'Task'}" has been approved and marked complete.${hasDelegation ? ` (You earned ${finalPoints} pts as delegator)` : ''}${assigneePenaltyToApply > 0 ? ` Late submission: ${assigneePenaltyToApply} pt penalty applied.` : ''}${assigneeLeave.exempt && isLate ? ' Your completion fell inside your approved leave, so no late penalty was applied.' : ''}`,
                    link: `/profile/unified?uid=${uid}&task=${taskId}`,
                    taskId,
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                };
                t.set(nref, assigneeNotifData);
                notifMirrors.push({ uid, id: nref.id, data: assigneeNotifData as unknown as Record<string, unknown> });
            });

            // Award points to the delegatee (the person who actually did the work)
            if (hasDelegation) {
                const delegateeUid = delegation.delegatedTo;
                const delegateePoints = typeof delegation.pointsShared === 'number' ? delegation.pointsShared : 0;
                // The delegatee is checked against THEIR OWN leave window,
                // independently of the assignee. One party can be exempt
                // while the other is penalized.
                const delegateeLeave = leaveExemptFor(String(delegateeUid));
                const delegateePenaltyToApply = delegateeLeave.exempt ? 0 : penaltyToApply;
                const delegateeCompletedLate = isLate && !delegateeLeave.exempt;
                const finalDelegateePoints = Math.max(0, delegateePoints - delegateePenaltyToApply);

                if (finalDelegateePoints > 0) {
                    const delegateeRef = db.collection('users').doc(delegateeUid);
                    if (supaPrimary) {
                        // C-07 guard swap: the delegatee award is
                        // claimed by the RPC post-commit (same
                        // deterministic COMPLETION ledger id family).
                        pendingAwards.push({
                            taskId,
                            userId: String(delegateeUid),
                            action: 'COMPLETION',
                            reason: 'task_completion_delegatee',
                            points: finalDelegateePoints,
                            countCompletion: true,
                            onTime: completedOnTime ? true : (delegateeCompletedLate ? false : null),
                            badgeIds: typeof completionBadgeId === 'string' && completionBadgeId ? [completionBadgeId] : [],
                        });
                    } else {
                    const dUpdates: any = {
                        lastTaskCompletedAt: completedAtTs,
                        tasksCompletedCount: admin.firestore.FieldValue.increment(1),
                        total_points: admin.firestore.FieldValue.increment(finalDelegateePoints),
                        points: admin.firestore.FieldValue.increment(finalDelegateePoints),
                    };
                    if (completedOnTime) dUpdates.tasksCompletedOnTimeCount = admin.firestore.FieldValue.increment(1);
                    if (delegateeCompletedLate) dUpdates.tasksCompletedLateCount = admin.firestore.FieldValue.increment(1);

                    t.set(delegateeRef, dUpdates, { merge: true });

                    // Ledger entry for delegatee
                    const dLedgerRef = db.collection('points_ledger').doc();
                    t.set(dLedgerRef, {
                        user_id: delegateeUid,
                        task_id: taskId,
                        reason: 'task_completion_delegatee',
                        action: 'COMPLETION',
                        points_awarded: finalDelegateePoints,
                        points_before_penalty: delegateePoints,
                        penalty_applied: delegateePenaltyToApply,
                        completed_late: delegateeCompletedLate,
                        ...(delegateeLeave.exempt ? { leave_exempt: true, leaveRequestId: delegateeLeave.leaveRequestId } : {}),
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                    }

                    // Notify delegatee — GAP-N1 site 2 of 3
                    const dNotifRef = db.collection('users').doc(delegateeUid).collection('notifications').doc();
                    const delegateeNotifData = {
                        type: 'submission_feedback',
                        title: delegateeCompletedLate ? 'Delegated Task Completed (Late) ⚠️' : 'Delegated Task Completed! 🎉',
                        body: `"${tTaskBefore.title || 'Task'}" was approved. You earned ${finalDelegateePoints} pts for your work.${delegateePenaltyToApply > 0 ? ` Late submission: ${delegateePenaltyToApply} pt penalty applied.` : ''}${delegateeLeave.exempt && isLate ? ' Your completion fell inside your approved leave, so no late penalty was applied.' : ''}`,
                        link: `/profile/unified?uid=${delegateeUid}&task=${taskId}`,
                        taskId,
                        isRead: false,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    };
                    t.set(dNotifRef, delegateeNotifData);
                    notifMirrors.push({ uid: String(delegateeUid), id: dNotifRef.id, data: delegateeNotifData as unknown as Record<string, unknown> });

                    // Badges for delegatee too (under Supa-primary the
                    // RPC above already unioned the completion badge)
                    if (!supaPrimary && completionBadgeId) {
                        t.set(delegateeRef, { badges: admin.firestore.FieldValue.arrayUnion(completionBadgeId) }, { merge: true });
                    }
                }
            }
        }

        // Apply collective distributions
        if (assignmentType === 'collective' && chapterId && !alreadyReceived) {
            if (supaPrimary) {
                // C-07 guard swap: collective award claimed by the
                // RPC post-commit, keyed pa_<taskId>_chapter_COMPLETION
                // (the RPC's claim is the authoritative guard here;
                // the Firestore ledger check above cannot see Supa
                // claims and stays as the OFF-path guard only).
                pendingAwards.push({
                    taskId,
                    userId: null,
                    chapterId,
                    action: 'COMPLETION',
                    points: pointsToAward,
                });
            } else {
            const chapterRef = db.collection('chapters').doc(chapterId);
            t.set(chapterRef, {
                collective_score: admin.firestore.FieldValue.increment(pointsToAward),
                tasks_completed: admin.firestore.FieldValue.increment(1)
            }, { merge: true });

            const ledgerRef = db.collection('points_ledger').doc();
            t.set(ledgerRef, {
                user_id: null,
                chapter_id: chapterId,
                task_id: taskId,
                action: 'COMPLETION',
                points_awarded: pointsToAward,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: 'PROCESSED'
            });
            }
        }

        // Parent Task Rollup Execution
        if (parentRef && parentData && allSiblingsCompleted && parentData.completion_bonus_points > 0) {
            t.update(parentRef, {
                status: 'completed',
                completedAt: completedAtTs,
                updatedAt: completedAtTs
            });

            const pBonus = parentData.completion_bonus_points;
            const pAssigneeIds = (Array.isArray(parentData.assigneeIds) ? parentData.assigneeIds : (parentData.assigneeId ? [String(parentData.assigneeId)] : []))
                .filter((uid: any) => typeof uid === 'string' ? uid.trim() !== '' : Boolean(uid))
                .map((uid: any) => String(uid));

            // Distribute Parent Bonus
            pAssigneeIds.forEach((uid: string) => {
                if (supaPrimary) {
                    // C-07 guard swap: rollup claimed by the RPC
                    // post-commit, keyed pa_<parentId>_<uid>_COMPLETION_ROLLUP.
                    pendingAwards.push({
                        taskId: String(parentId),
                        userId: uid,
                        action: 'COMPLETION_ROLLUP',
                        points: pBonus,
                    });
                    return;
                }
                const uRef = db.collection('users').doc(uid);
                t.set(uRef, {
                    total_points: admin.firestore.FieldValue.increment(pBonus),
                    points: admin.firestore.FieldValue.increment(pBonus)
                }, { merge: true });

                const pLedger = db.collection('points_ledger').doc();
                t.set(pLedger, {
                    user_id: uid,
                    task_id: parentId,
                    action: 'COMPLETION_ROLLUP',
                    points_awarded: pBonus,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'PROCESSED'
                });
            });
        }

        // Auto-Handoff Workflow Next Step
        if (nextStepRef) {
            t.update(nextStepRef, {
                releasedAt: completedAtTs,
                isCurrentStep: true,
                updatedAt: completedAtTs
            });

            const wfTitle = tTaskBefore.workflowTitle || 'Workflow';
            const stepTitle = nextStepData?.title || 'Step';
            const participants = Array.isArray(tTaskBefore.workflowParticipantIds) ? tTaskBefore.workflowParticipantIds : [];
            const targets = new Set<string>([...participants, nextStepAssignee].filter(Boolean));

            targets.forEach(uid => {
                const isNext = uid === nextStepAssignee;
                const nr = db.collection('users').doc(uid as string).collection('notifications').doc();
                // Firestore rejects undefined field values, so the link is
                // only added for the next assignee. A previous build set
                // link: undefined for every other participant, which threw
                // inside the transaction and 500ed every non-final workflow
                // step completion.
                const notificationPayload: Record<string, any> = {
                    type: isNext ? 'task_assigned' : 'task_status_change',
                    title: isNext ? 'Your Turn!' : 'Workflow Update',
                    body: isNext ? `It's your turn on "${wfTitle}" - Step: ${stepTitle}` : `"${wfTitle}" progressed to step: ${stepTitle}`,
                    workflowId: wfId,
                    stepIndex: (seq || 0) + 1,
                    isRead: false,
                    timestamp: completedAtTs
                };
                if (isNext) {
                    notificationPayload.link = `/profile/unified?uid=${uid}&workflow=${wfId}`;
                }
                t.set(nr, notificationPayload);
                // GAP-N1 site 3 of 3 (workflow handoff notifications)
                notifMirrors.push({ uid: String(uid), id: nr.id, data: notificationPayload as unknown as Record<string, unknown> });
            });
        } else if (wfId && typeof seq === 'number') {
            // C-07 NAMED BLOCKER (B-GAME-1): the WORKFLOW_BONUS award in
            // this branch is NOT converted to the RPC, even under
            // Supa-primary. Its ledger row carries NO task_id (it is
            // keyed by workflowId) and its user write increments
            // workflowsCompletedCount — neither shape exists in
            // apply_points_award (p_task_id is required; the RPC has no
            // workflows-completed counter). Converting it would change
            // the ledger shape and lose the counter. It stays on the
            // Firestore path until the SQL gains a workflow-bonus
            // variant; see the C-07 section report.
            // Final Workflow Step Completed. The seq guard above means a
            // missing or non-numeric sequenceIndex never reaches this
            // branch, so no final bonus is awarded on ambiguous data.
            const participants = (Array.isArray(tTaskBefore.workflowParticipantIds) ? tTaskBefore.workflowParticipantIds : [])
                .filter((uid: any) => typeof uid === 'string' ? uid.trim() !== '' : Boolean(uid))
                .map((uid: any) => String(uid));
            const wbBonus = typeof tTaskBefore.workflowBonusPoints === 'number' ? tTaskBefore.workflowBonusPoints : 10;

            participants.forEach(uid => {
                const uRef = db.collection('users').doc(uid as string);

                const writePayload: any = {};
                if (wbBonus > 0) {
                    writePayload.points = admin.firestore.FieldValue.increment(wbBonus);
                    writePayload.total_points = admin.firestore.FieldValue.increment(wbBonus);
                    writePayload.workflowsCompletedCount = admin.firestore.FieldValue.increment(1);

                    const wLedger = db.collection('points_ledger').doc();
                    t.set(wLedger, {
                        user_id: uid,
                        action: 'WORKFLOW_BONUS',
                        workflowId: wfId,
                        points_awarded: wbBonus,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                }
                if (finalWorkflowCompletionBadgeId) {
                    writePayload.badges = admin.firestore.FieldValue.arrayUnion(finalWorkflowCompletionBadgeId);
                }

                if (Object.keys(writePayload).length > 0) {
                    t.set(uRef, writePayload, { merge: true });
                }
            });
        }

        // Activity Log
        const actRef = db.collection('tasks').doc(taskId).collection('activity').doc();
        t.set(actRef, {
            type: 'approval',
            userId: actorUid,
            data: { action: 'approved', previousStatus: tTaskBefore.status || 'unknown' },
            createdAt: completedAtTs
        });

        return {
            success: true,
            taskId,
            pointsAwardedTotal: unpaidAssigneeIds.length > 0 ? Math.max(0, pointsToAward - penaltyToApply) * unpaidAssigneeIds.length : 0,
            penaltyApplied: penaltyToApply,
            completedOnTime,
            completedLate: isLate,
            assignmentType,
            leaveExemptAssignees: unpaidAssigneeIds.filter((uid) => leaveExemptFor(uid).exempt),
        };
    });

    // Post-commit flush (the transaction has committed at this point):
    // 1. C-07 awards via the RPC. A duplicate result is the guard
    //    working (already claimed on the Supa side) — not an error.
    //    A null result means the RPC rolled back / primary dropped
    //    between the gate and the flush: the Firestore completion is
    //    already committed, so this is logged loudly for operator
    //    replay rather than thrown (throwing would DLQ a completed
    //    task and the retry would die on the already-completed guard).
    for (const award of pendingAwards) {
        const awardResult = await applyPointsAwardViaSupa(award);
        if (awardResult === null) {
            console.error('[gamification C-07] post-commit award did not land on Supa primary; task completion already committed, award needs operator replay:', award);
        }
    }
    // 2. GAP-N1 notification mirrors for the 3 converted sites.
    for (const m of notifMirrors) {
        await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
    }

    return result;
}
