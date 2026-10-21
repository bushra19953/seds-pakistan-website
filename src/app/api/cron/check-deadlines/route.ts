import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { isExemptFromDeadlinePenalty } from '@/lib/server/leave-exemption';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { NextRequest } from 'next/server';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';
import { taskHasProofUploaded } from '@/lib/server/bug4-proof-guards';

export const dynamic = 'force-dynamic';

async function runCheckDeadlines(req: NextRequest) {
    try {
        // 1. Authorization: Ensure called by Admin or Vercel Cron
        const authHeader = req.headers.get('Authorization');
        const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;

        if (!isCron) {
            const auth = await verifyAuthentication(req);
            if (!auth.authenticated || !auth.user?.role) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const adminDb = getDb();
        if (!adminDb) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        // 2. Load configurable warning settings
        let warnSettings: WarningSettings = { ...DEFAULT_WARNING_SETTINGS };
        try {
            const settingsSnap = await adminDb.collection('warningConfig').doc('global').get();
            if (settingsSnap.exists) {
                warnSettings = { ...DEFAULT_WARNING_SETTINGS, ...(settingsSnap.data() as Partial<WarningSettings>) };
            }
        } catch (e) {
            console.warn('[cron/check-deadlines] Failed to load warningSettings, using defaults:', e);
        }

        // If auto-issue is disabled globally, skip
        if (warnSettings.autoIssueOnDeadlineMiss === false) {
            return NextResponse.json({
                success: true,
                checked: 0,
                overdue: 0,
                tasksProcessed: 0,
                warningsIssued: 0,
                blacklistsTriggered: 0,
                skipped: 0,
                skippedDetails: [],
                failed: 0,
                failedDetails: [],
                message: 'Skipped: auto-issue on deadline miss is disabled in warning settings.',
            });
        }

        const now = Timestamp.now();
        const expirationMs = (warnSettings.expirationDays ?? 90) * 24 * 60 * 60 * 1000;
        const expiresAt = Timestamp.fromMillis(now.toMillis() + expirationMs);
        const blacklistThreshold = warnSettings.blacklistThreshold ?? 3;
        const penaltyPoints = warnSettings.penaltyPoints ?? 5;

        const tasksRef = adminDb.collection('tasks');
        const usersRef = adminDb.collection('users');

        // 3. Query based ONLY on status. Firestore prohibits multiple inequality filters/complex 
        // combinations without a dedicated composite index. We filter deadline client-side.
        const snapshot = await tasksRef
            .where('status', 'in', ['pending', 'in-progress', 'overdue'])
            .get();

        const nowMillis = now.toMillis();
        
        // Manual JS Deadline Calculation
        const overdueDocs = snapshot.docs.filter(doc => {
            const data = doc.data();
            // IMPROVEMENT: Check both individualDeadline (workflow steps) and global deadline
            const rawDeadline = data.individualDeadline || data.deadline;
            if (!rawDeadline) return false;
            
            let deadlineMs = 0;
            if (typeof rawDeadline.toMillis === 'function') {
                deadlineMs = rawDeadline.toMillis();
            } else if (rawDeadline instanceof Date) {
                deadlineMs = rawDeadline.getTime();
            } else if (typeof rawDeadline === 'string' || typeof rawDeadline === 'number') {
                deadlineMs = new Date(rawDeadline).getTime();
            }
            
            return deadlineMs > 0 && deadlineMs < nowMillis;
        });

        // BUG 4 FIX (2026-10-20): a task with proof uploaded must never be
        // warned, penalized, or stamped overdue. A non-empty deliverableFiles
        // array means the assignee already submitted proof; the task is
        // awaiting review, not missing work. Split such docs off BEFORE the
        // overdueProcessed filter and before the processing loop, so none of
        // the downstream warning/penalty/stamp logic touches them.
        const withProof: typeof overdueDocs = [];
        const withoutProof: typeof overdueDocs = [];
        for (const doc of overdueDocs) {
            if (taskHasProofUploaded(doc.data())) withProof.push(doc);
            else withoutProof.push(doc);
        }
        const proofSkippedDocs = withProof;
        const overdueNoProofDocs = withoutProof;

        const skippedDetails: Array<{ taskId: string; title: string; assigneeId?: string; reason: string }> =
            proofSkippedDocs.map(doc => ({
                taskId: doc.id,
                title: doc.data().title || 'Untitled Task',
                reason: 'proof uploaded; awaiting review',
            }));

        // ROOT-CAUSE FIX (2026-10-13, worker B1): previously the route filtered
        // docsToProcess to status 'pending'/'in-progress' only. Any step whose status
        // had ALREADY flipped to 'overdue' (via the task approval flow, UI action, or a
        // partial prior run) was silently excluded and the route falsely reported that
        // those tasks "have already been processed and penalized previously". The
        // idempotency marker `overdueProcessed` is the only legitimate gate: a step
        // with status 'overdue' but overdueProcessed !== true never went through this
        // penalty flow, so it must be processed now, exactly once.
        const docsToProcess = overdueNoProofDocs.filter(doc => doc.data().overdueProcessed !== true);

        const alreadyProcessedCount = overdueNoProofDocs.length - docsToProcess.length;

        if (docsToProcess.length === 0) {
            if (overdueDocs.length > 0) {
                for (const doc of overdueNoProofDocs) {
                    if (doc.data().overdueProcessed === true) {
                        skippedDetails.push({
                            taskId: doc.id,
                            title: doc.data().title || 'Untitled Task',
                            reason: 'already processed by a previous run (overdueProcessed marker set)',
                        });
                    }
                }
                return NextResponse.json({
                    success: true,
                    checked: snapshot.size,
                    overdue: overdueDocs.length,
                    tasksProcessed: 0,
                    warningsIssued: 0,
                    blacklistsTriggered: 0,
                    skipped: skippedDetails.length,
                    skippedDetails,
                    failed: 0,
                    failedDetails: [],
                    message: `All ${skippedDetails.length} currently overdue task(s) were skipped: ${proofSkippedDocs.length} with proof uploaded (awaiting review), ${alreadyProcessedCount} already processed by a previous run. No new warnings issued.`,
                });
            }
            return NextResponse.json({
                success: true,
                checked: snapshot.size,
                overdue: 0,
                tasksProcessed: 0,
                warningsIssued: 0,
                blacklistsTriggered: 0,
                skipped: 0,
                skippedDetails: [],
                failed: 0,
                failedDetails: [],
                message: 'No overdue tasks found.',
            });
        }

        let warningCount = 0;
        let blacklistCount = 0;
        let tasksProcessedCount = 0;
        const failedDetails: Array<{ taskId: string; title: string; error: string }> = [];

        for (const taskDoc of docsToProcess) {
            const task = taskDoc.data();
            const taskId = taskDoc.id;
            const taskTitle = String(task.title || 'Untitled Task');
            try {
                // Every assignee (doer and oversight) is accountable for the deadline.
                const assigneeIds: string[] = Array.isArray(task.assigneeIds) && task.assigneeIds.length
                    ? task.assigneeIds.map(String).filter(Boolean)
                    : (task.assigneeId ? [String(task.assigneeId)] : []);

                if (assigneeIds.length === 0) {
                    skippedDetails.push({
                        taskId,
                        title: taskTitle,
                        reason: 'no assignees assigned; no one to warn. Not marked processed so a retry can pick it up if assignees are added later.',
                    });
                    continue;
                }

                // The whole-task stamp used to be applied here BEFORE the
                // per-assignee loop, which marked exempt assignees as
                // processed without ever checking their leave. It now runs
                // AFTER the loop and only when at least one assignee was
                // actually processed, so an all-exempt task stays
                // unprocessed and is revisited after the member returns.
                // A mixed task is stamped once a non-exempt assignee is
                // processed; the exempt assignee in that task is NOT
                // revisited later (known v1 limitation).
                let processedAssigneeCount = 0;

                for (const assigneeId of assigneeIds) {
                try {
                    // Read user doc to get current count
                    const userRef = usersRef.doc(assigneeId);
                    const userDoc = await userRef.get();
                    if (!userDoc.exists) {
                        skippedDetails.push({
                            taskId,
                            title: taskTitle,
                            assigneeId,
                            reason: 'user record not found; cannot issue warning or penalty.',
                        });
                        continue;
                    }

                    const userData = userDoc.data()!;

                    // Leave exemption. When the deadline falls inside the
                    // assignee's approved leave window, skip this assignee
                    // entirely: no warning, no points deduction, no
                    // blacklist count, and the task is NOT marked processed
                    // for them. The leave request id is logged so the skip
                    // is auditable.
                    const leaveCheck = isExemptFromDeadlinePenalty(
                        userData,
                        task
                    );
                    if (leaveCheck.exempt) {
                        console.log(
                            `[check-deadlines] Task ${taskId} skipped for assignee ${assigneeId}: ` +
                                `${leaveCheck.reason} (leaveRequestId: ${leaveCheck.leaveRequestId ?? 'none'})`
                        );
                        skippedDetails.push({
                            taskId,
                            title: taskTitle,
                            assigneeId,
                            reason: `On approved leave (${leaveCheck.reason}). No warning or penalty issued; task not marked processed for this assignee.`,
                        });
                        continue;
                    }

                    const currentWarnings = userData.warningCount || 0;
                    const newWarnings = currentWarnings + 1;
                    const shouldBlacklist = newWarnings >= blacklistThreshold && !userData.isBlacklisted;
                    const effectivePenalty = typeof task.penaltyPoints === 'number' ? task.penaltyPoints : penaltyPoints;

                    // Write to warnings subcollection (production-grade, queryable)
                    const warningRef = userRef.collection('warnings').doc();
                    const warningData = {
                        reason: `Missed deadline for task: ${task.title || 'Untitled Task'}`,
                        type: 'missed-deadline',
                        severity: 'medium',
                        notes: '',
                        createdBy: 'system',
                        createdAt: now,
                        expiresAt: expiresAt,
                        isActive: true,
                        taskId: taskId,
                        taskTitle: task.title || 'Untitled Task',
                        appealStatus: 'none',
                        penaltyPoints: effectivePenalty,
                    };

                    const historyEntry = {
                        date: new Date().toISOString(),
                        reason: `Missed deadline for task: ${task.title || 'Untitled Task'}`,
                        taskId: taskId,
                        revoked: false,
                    };

                    const userUpdate: Record<string, unknown> = {
                        warningCount: FieldValue.increment(1),
                        warningHistory: FieldValue.arrayUnion(historyEntry),
                    };

                    if (effectivePenalty > 0) {
                        userUpdate.points = FieldValue.increment(-effectivePenalty);
                        userUpdate.totalPenalties = FieldValue.increment(effectivePenalty);
                        userUpdate.missedDeadlinesCount = FieldValue.increment(1);

                        // Points audit log
                        await adminDb.collection('points_audit').add({
                            userId: assigneeId,
                            delta: -effectivePenalty,
                            reason: 'deadline_missed_penalty',
                            taskId: taskId,
                            taskTitle: String(task.title || 'Task'),
                            workflowId: task.workflowId || null,
                            timestamp: now,
                            actorId: 'system',
                        });

                        // Notification
                        notificationService.send(assigneeId, {
                            type: 'penalty_applied',
                            title: 'Deadline Missed, Warning Issued',
                            body: `You missed the deadline for "${task.title || 'Task'}" and received a warning plus a ${effectivePenalty} point penalty.`,
                            link: `/profile/unified?uid=${assigneeId}`,
                            metadata: { taskId },
                        }, 'P0').catch(err => console.error('[cron/check-deadlines] Notification failed:', err));
                    }

                    if (shouldBlacklist) {
                        userUpdate.isBlacklisted = true;
                        userUpdate.blacklistReason = `Reached ${blacklistThreshold} active warnings (${newWarnings} total).`;
                        userUpdate.blacklistedAt = now;
                        userUpdate.isBanned = true;
                        userUpdate.banReason = `Exceeded ${blacklistThreshold} warnings. Auto-blacklisted.`;
                        blacklistCount++;

                        // Notify admin-level audit
                        notificationService.send(assigneeId, {
                            type: 'account_blacklisted',
                            title: 'Account Blacklisted',
                            body: `Your account has been blacklisted after reaching ${blacklistThreshold} warnings.`,
                            link: `/banned`,
                            metadata: {},
                        }, 'P0').catch(err => console.error('[cron/check-deadlines] Blacklist notification failed:', err));
                    }

                    // Write warning subcollection doc and user update atomically
                    const batch = adminDb.batch();
                    batch.set(warningRef, warningData);
                    batch.update(userRef, userUpdate);
                    await batch.commit();

                    warningCount++;
                    processedAssigneeCount++;
                } catch (assigneeError: any) {
                    // One bad assignee must not abort the rest of the batch.
                    failedDetails.push({
                        taskId,
                        title: taskTitle,
                        error: `assignee ${assigneeId}: ${assigneeError?.message || String(assigneeError)}`,
                    });
                }
                } // end per-assignee loop

                // Conditional whole-task stamp: only when at least one
                // assignee was actually processed. All-exempt tasks keep
                // their prior status and are revisited on later runs.
                if (processedAssigneeCount > 0) {
                    await taskDoc.ref.update({
                        status: 'overdue',
                        overdueProcessed: true,
                        updatedAt: now,
                    });
                    tasksProcessedCount++;
                }
            } catch (taskError: any) {
                // One bad task must not abort the rest of the batch.
                failedDetails.push({
                    taskId,
                    title: taskTitle,
                    error: taskError?.message || String(taskError),
                });
            }
        }

        const skippedCount = skippedDetails.length;
        const failedCount = failedDetails.length;

        // Phase 2 (spec C.6): interim host for the Governor term sweep until
        // Workstream D's governance cron lands. A separate named step at the
        // end of this handler, behind the same CRON_SECRET auth, removable
        // without touching the deadline logic. Never allowed to fail the
        // deadline run.
        let governorTermSweep: unknown = null;
        try {
            const { runGovernorTermSweep } = await import('@/lib/server/governors/term-sweep');
            governorTermSweep = await runGovernorTermSweep(adminDb as never, new Date());
        } catch (sweepError: any) {
            console.error('[cron/check-deadlines] governor term sweep failed:', sweepError);
            governorTermSweep = { error: sweepError?.message || String(sweepError) };
        }

        return NextResponse.json({
            success: true,
            checked: snapshot.size,
            overdue: overdueDocs.length,
            alreadyProcessed: alreadyProcessedCount,
            tasksProcessed: tasksProcessedCount,
            warningsIssued: warningCount,
            blacklistsTriggered: blacklistCount,
            skipped: skippedCount,
            skippedDetails,
            failed: failedCount,
            failedDetails,
            message:
                warningCount === 0 && skippedCount === 0 && failedCount === 0
                    ? `Processed ${tasksProcessedCount} overdue task(s) with no warnings issued.`
                    : `Processed ${tasksProcessedCount} overdue task(s): ${warningCount} warning(s) issued, ${skippedCount} skipped, ${failedCount} failed.`,
            settings: {
                expirationDays: warnSettings.expirationDays,
                blacklistThreshold,
                penaltyPoints,
            },
            governorTermSweep,
        });

    } catch (error: any) {
        console.error('[cron/check-deadlines] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// Vercel Cron Jobs invoke the path with GET.
export async function GET(req: NextRequest) {
    return runCheckDeadlines(req);
}

// Manual / admin-triggered invocation.
export async function POST(req: NextRequest) {
    return runCheckDeadlines(req);
}
