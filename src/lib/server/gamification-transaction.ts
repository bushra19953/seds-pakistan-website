import { admin, getDb } from '@/lib/server/firebase-admin';

export async function executeGamificationTransaction(
    taskId: string,
    updatesToApply: any,
    taskBefore: any,
    actorUid: string
) {
    const db = getDb();
    if (!db) throw new Error('Firestore not initialized');

    return await db.runTransaction(async (t) => {
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

        // Determine assignee(s)
        const assigneeIds: string[] = Array.isArray(tTaskBefore.assigneeIds)
            ? tTaskBefore.assigneeIds
            : tTaskBefore.assigneeId ? [String(tTaskBefore.assigneeId)] : [];

        // Assignment Type (Individual vs Collective)
        const assignmentType = tTaskBefore.assignment_type || 'individual'; // collective points route to chapters
        const chapterId = tTaskBefore.assignee_id; // If collective, assignee_id acts as chapter_id

        // Point Math (Split vs Duplicate)
        const basePoints = typeof tTaskBefore.points === 'number' ? tTaskBefore.points : (tTaskBefore.base_points || 0);
        const distributionMode = tTaskBefore.point_distribution_mode || 'duplicate';
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

        // Auto-Handoff Next Step Read (if workflow)
        let nextStepRef = null;
        let nextStepData = null;
        let nextStepAssignee = null;
        const wfId = tTaskBefore.workflowId ? String(tTaskBefore.workflowId) : null;
        const seq = Number.isFinite(Number(tTaskBefore.sequenceIndex)) ? Number(tTaskBefore.sequenceIndex) : undefined;
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
        if (deadlineDate) {
            completedOnTime = completedAtTs.toDate().getTime() <= deadlineDate.getTime();
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
            status: updatesToApply.status === 'approved' ? 'approved' : 'completed' // Support both
        };
        t.update(taskRef, taskWritePayload);

        // Apply individual distributions
        // Check for accepted delegation — if present, split points between delegator and delegatee
        const delegation = tTaskBefore.delegation;
        const hasDelegation = delegation && delegation.status === 'accepted' && delegation.delegatedTo;

        if (assignmentType === 'individual' && !alreadyReceived) {
            assigneeIds.forEach(uid => {
                // If this task was delegated, the original assignee gets pointsKept instead of full points
                const effectivePoints = hasDelegation
                    ? (typeof delegation.pointsKept === 'number' ? delegation.pointsKept : pointsToAward)
                    : pointsToAward;

                // Apply deadline penalty: deduct from awarded points if late
                const finalPoints = Math.max(0, effectivePoints - penaltyToApply);

                const userRef = db.collection('users').doc(uid);
                const uUpdates: any = {
                    lastTaskCompletedAt: completedAtTs,
                    tasksCompletedCount: admin.firestore.FieldValue.increment(1),
                    // The task is no longer outstanding, so release it from the
                    // denormalized workload counter. The workload API counts
                    // active tasks live; this keeps the display counter truthful.
                    tasksAssignedCount: admin.firestore.FieldValue.increment(-1),
                };
                if (completedOnTime) uUpdates.tasksCompletedOnTimeCount = admin.firestore.FieldValue.increment(1);
                if (isLate) uUpdates.tasksCompletedLateCount = admin.firestore.FieldValue.increment(1);

                if (finalPoints > 0) {
                    uUpdates.total_points = admin.firestore.FieldValue.increment(finalPoints);
                    uUpdates.points = admin.firestore.FieldValue.increment(finalPoints); // legacy fallback

                    // Double-dipping lock ledger entry
                    const ledgerRef = db.collection('points_ledger').doc();
                    t.set(ledgerRef, {
                        user_id: uid,
                        task_id: taskId,
                        reason: hasDelegation ? 'task_completion_delegator' : 'task_completion',
                        action: 'COMPLETION',
                        points_awarded: finalPoints,
                        points_before_penalty: effectivePoints,
                        penalty_applied: penaltyToApply,
                        completed_late: isLate,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                } else if (penaltyToApply > 0) {
                    // Penalty wiped out all points — still log it
                    const ledgerRef = db.collection('points_ledger').doc();
                    t.set(ledgerRef, {
                        user_id: uid,
                        task_id: taskId,
                        reason: 'task_completion_penalty',
                        action: 'PENALTY',
                        points_awarded: 0,
                        points_before_penalty: effectivePoints,
                        penalty_applied: penaltyToApply,
                        completed_late: true,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                }

                const taskHoursWorked = typeof updatesToApply.hoursWorked === 'number'
                    ? updatesToApply.hoursWorked
                    : (typeof tTaskBefore.hoursWorked === 'number' ? tTaskBefore.hoursWorked : 0);
                if (taskHoursWorked > 0) uUpdates.totalHoursWorked = admin.firestore.FieldValue.increment(taskHoursWorked);

                t.set(userRef, uUpdates, { merge: true });

                // Badges
                if (completionBadgeId) {
                    t.set(userRef, { badges: admin.firestore.FieldValue.arrayUnion(completionBadgeId) }, { merge: true });
                }
                if (stepSpecificBadgeId) {
                    t.set(userRef, { badges: admin.firestore.FieldValue.arrayUnion(stepSpecificBadgeId) }, { merge: true });
                }

                // Notifications
                const nref = db.collection('users').doc(uid).collection('notifications').doc();
                t.set(nref, {
                    type: 'submission_feedback',
                    title: isLate ? 'Task Approved (Late) ⚠️' : 'Task Approved! 🎉',
                    body: `"${tTaskBefore.title || 'Task'}" has been approved and marked complete.${hasDelegation ? ` (You earned ${finalPoints} pts as delegator)` : ''}${penaltyToApply > 0 ? ` Late submission: ${penaltyToApply} pt penalty applied.` : ''}`,
                    link: `/profile/unified?uid=${uid}&task=${taskId}`,
                    taskId,
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            // Award points to the delegatee (the person who actually did the work)
            if (hasDelegation) {
                const delegateeUid = delegation.delegatedTo;
                const delegateePoints = typeof delegation.pointsShared === 'number' ? delegation.pointsShared : 0;
                const finalDelegateePoints = Math.max(0, delegateePoints - penaltyToApply);

                if (finalDelegateePoints > 0) {
                    const delegateeRef = db.collection('users').doc(delegateeUid);
                    const dUpdates: any = {
                        lastTaskCompletedAt: completedAtTs,
                        tasksCompletedCount: admin.firestore.FieldValue.increment(1),
                        total_points: admin.firestore.FieldValue.increment(finalDelegateePoints),
                        points: admin.firestore.FieldValue.increment(finalDelegateePoints),
                    };
                    if (completedOnTime) dUpdates.tasksCompletedOnTimeCount = admin.firestore.FieldValue.increment(1);
                    if (isLate) dUpdates.tasksCompletedLateCount = admin.firestore.FieldValue.increment(1);

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
                        penalty_applied: penaltyToApply,
                        completed_late: isLate,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });

                    // Notify delegatee
                    const dNotifRef = db.collection('users').doc(delegateeUid).collection('notifications').doc();
                    t.set(dNotifRef, {
                        type: 'submission_feedback',
                        title: isLate ? 'Delegated Task Completed (Late) ⚠️' : 'Delegated Task Completed! 🎉',
                        body: `"${tTaskBefore.title || 'Task'}" was approved. You earned ${finalDelegateePoints} pts for your work.${penaltyToApply > 0 ? ` Late submission: ${penaltyToApply} pt penalty applied.` : ''}`,
                        link: `/profile/unified?uid=${delegateeUid}&task=${taskId}`,
                        taskId,
                        isRead: false,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });

                    // Badges for delegatee too
                    if (completionBadgeId) {
                        t.set(delegateeRef, { badges: admin.firestore.FieldValue.arrayUnion(completionBadgeId) }, { merge: true });
                    }
                }
            }
        }

        // Apply collective distributions
        if (assignmentType === 'collective' && chapterId && !alreadyReceived) {
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

        // Parent Task Rollup Execution
        if (parentRef && parentData && allSiblingsCompleted && parentData.completion_bonus_points > 0) {
            t.update(parentRef, {
                status: 'completed',
                completedAt: completedAtTs,
                updatedAt: completedAtTs
            });

            const pBonus = parentData.completion_bonus_points;
            const pAssigneeIds = Array.isArray(parentData.assigneeIds) ? parentData.assigneeIds : (parentData.assigneeId ? [String(parentData.assigneeId)] : []);

            // Distribute Parent Bonus
            pAssigneeIds.forEach((uid: string) => {
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
                t.set(nr, {
                    type: isNext ? 'task_assigned' : 'task_status_change',
                    title: isNext ? 'Your Turn!' : 'Workflow Update',
                    body: isNext ? `It's your turn on "${wfTitle}" - Step: ${stepTitle}` : `"${wfTitle}" progressed to step: ${stepTitle}`,
                    link: isNext ? `/profile/unified?uid=${uid}&workflow=${wfId}` : undefined,
                    workflowId: wfId,
                    stepIndex: (seq || 0) + 1,
                    isRead: false,
                    timestamp: completedAtTs
                });
            });
        } else if (wfId) {
            // Final Workflow Step Completed
            const participants = Array.isArray(tTaskBefore.workflowParticipantIds) ? tTaskBefore.workflowParticipantIds : [];
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
            pointsAwardedTotal: alreadyReceived ? 0 : Math.max(0, pointsToAward - penaltyToApply),
            penaltyApplied: penaltyToApply,
            completedOnTime,
            completedLate: isLate,
            assignmentType
        };
    });
} 
