import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { Timestamp } from 'firebase-admin/firestore';
import { isExemptFromDeadlinePenalty } from '@/lib/server/leave-exemption';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { NextRequest } from 'next/server';
import { taskHasProofUploaded } from '@/lib/server/bug4-proof-guards';
import { getDisciplineSettings } from '@/lib/server/discipline/settings';
import { evaluateReferralPatterns, recordMiss } from '@/lib/server/discipline/miss-records';

export const dynamic = 'force-dynamic';

/**
 * check-deadlines - CONVERTED by the Phase 2 discipline rebuild
 * (spec E.6).
 *
 * This cron used to ISSUE WARNINGS: it wrote warning docs, incremented
 * warningCount, deducted points, and auto-blacklisted/banned members at
 * a threshold. That entire issuance block is DELETED. Sanctions now
 * exist only as the recorded outcome of a decided disciplinary case
 * (applyCaseDecision).
 *
 * What the cron does now:
 *   1. Detects overdue incomplete tasks with the SAME predicate as
 *      before (status in pending/in-progress/overdue, deadline passed,
 *      not yet overdueProcessed).
 *   2. PRESERVED PRECEDENCE INVARIANT: the proof-uploaded split and the
 *      approved-leave exemption are evaluated BEFORE anything is
 *      recorded - a task with proof uploaded, or an assignee on
 *      approved leave covering the deadline, produces NO miss record.
 *   3. Writes ONE idempotent deadline_miss_records doc per
 *      (task, assignee) - a fact, with no consequence fields.
 *   4. Sends the assignee a neutral overdue-task notification (no
 *      warning or penalty language).
 *   5. Evaluates referral patterns: >= threshold recorded misses in
 *      the window create ONE referral draft attributed to a human.
 *
 * The conversion is gated by settings/discipline.cronReferralLive
 * (default FALSE = shadow): until cutover, this cron performs no
 * writes at all. The old warning path does NOT come back when the flag
 * is off - it is deleted, not disabled.
 */
async function runCheckDeadlines(req: NextRequest) {
    try {
        // 1. Authorization: Ensure called by Admin or Vercel Cron
        const authHeader = req.headers.get('Authorization');
        const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

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

        // 2. Cutover gate (E.9): the converted behaviour runs only when
        // the discipline settings say so. Default is shadow (no writes).
        const disciplineSettings = await getDisciplineSettings(adminDb);
        if (!disciplineSettings.cronReferralLive) {
            return NextResponse.json({
                success: true,
                checked: 0,
                overdue: 0,
                tasksProcessed: 0,
                warningsIssued: 0,
                blacklistsTriggered: 0,
                missRecordsCreated: 0,
                referralDraftsCreated: 0,
                skipped: 0,
                skippedDetails: [],
                failed: 0,
                failedDetails: [],
                message: 'Shadow mode: deadline-miss recording is not live yet (settings/discipline.cronReferralLive is false). The legacy auto-warning path has been retired and issues nothing.',
            });
        }

        // Custom Roles Fix Program (contracts 5.1): the custom-role
        // expiry sweep is hosted as a named step of this daily run.
        // It executes ONCE, here - after the cutover gate (shadow mode
        // performs no writes at all, and the sweep writes) and before
        // the deadline scan, because this handler's early returns below
        // would otherwise skip it on quiet days; its summary rides
        // every response this handler returns from this point, beside
        // governorTermSweep in the full-run response. Its own
        // try/catch: a sweep failure can never fail the deadline run.
        let customRoleExpirySweep: unknown = null;
        try {
            const { runCustomRoleExpirySweep } = await import('@/lib/server/custom-role-expiry-sweep');
            customRoleExpirySweep = await runCustomRoleExpirySweep(adminDb as never, new Date());
        } catch (sweepError: any) {
            console.error('[cron/check-deadlines] custom role expiry sweep failed:', sweepError);
            customRoleExpirySweep = { error: sweepError?.message || String(sweepError) };
        }

        const now = Timestamp.now();
        const nowDate = now.toDate();

        const tasksRef = adminDb.collection('tasks');
        const usersRef = adminDb.collection('users');

        // 3. Query based ONLY on status. Firestore prohibits multiple inequality filters/complex
        // combinations without a dedicated composite index. We filter deadline client-side.
        const snapshot = await tasksRef
            .where('status', 'in', ['pending', 'in-progress', 'overdue'])
            .get();

        const nowMillis = now.toMillis();

        // Manual JS Deadline Calculation (unchanged detection predicate)
        const overdueDocs = snapshot.docs.filter(doc => {
            const data = doc.data();
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

        // PRECEDENCE INVARIANT (preserved exactly): a task with proof
        // uploaded is awaiting review, not missing work. Such docs are
        // split off BEFORE the overdueProcessed filter and before any
        // recording, so no miss record is ever written for them.
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

        // Idempotency: the overdueProcessed marker is the only legitimate
        // gate for re-processing a task.
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
                    missRecordsCreated: 0,
                    referralDraftsCreated: 0,
                    skipped: skippedDetails.length,
                    skippedDetails,
                    failed: 0,
                    failedDetails: [],
                    message: `All ${skippedDetails.length} currently overdue task(s) were skipped: ${proofSkippedDocs.length} with proof uploaded (awaiting review), ${alreadyProcessedCount} already processed by a previous run. No new miss records.`,
                    customRoleExpirySweep,
                });
            }
            return NextResponse.json({
                success: true,
                checked: snapshot.size,
                overdue: 0,
                tasksProcessed: 0,
                warningsIssued: 0,
                blacklistsTriggered: 0,
                missRecordsCreated: 0,
                referralDraftsCreated: 0,
                skipped: 0,
                skippedDetails: [],
                failed: 0,
                failedDetails: [],
                message: 'No overdue tasks found.',
                customRoleExpirySweep,
            });
        }

        let missRecordsCreated = 0;
        let tasksProcessedCount = 0;
        const failedDetails: Array<{ taskId: string; title: string; error: string }> = [];

        for (const taskDoc of docsToProcess) {
            const task = taskDoc.data();
            const taskId = taskDoc.id;
            const taskTitle = String(task.title || 'Untitled Task');
            try {
                const assigneeIds: string[] = Array.isArray(task.assigneeIds) && task.assigneeIds.length
                    ? task.assigneeIds.map(String).filter(Boolean)
                    : (task.assigneeId ? [String(task.assigneeId)] : []);

                if (assigneeIds.length === 0) {
                    skippedDetails.push({
                        taskId,
                        title: taskTitle,
                        reason: 'no assignees assigned; no miss to record. Not marked processed so a retry can pick it up if assignees are added later.',
                    });
                    continue;
                }

                // The whole-task stamp runs AFTER the per-assignee loop
                // and only when at least one assignee was actually
                // recorded, so an all-exempt task stays unprocessed and
                // is revisited after the member returns.
                let recordedAssigneeCount = 0;

                for (const assigneeId of assigneeIds) {
                try {
                    const userRef = usersRef.doc(assigneeId);
                    const userDoc = await userRef.get();
                    if (!userDoc.exists) {
                        skippedDetails.push({
                            taskId,
                            title: taskTitle,
                            assigneeId,
                            reason: 'user record not found; cannot record a miss.',
                        });
                        continue;
                    }

                    const userData = userDoc.data()!;

                    // PRECEDENCE INVARIANT (preserved exactly): the
                    // approved-leave exemption is evaluated BEFORE the
                    // miss record. An exempt assignee gets NO record.
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
                            reason: `On approved leave (${leaveCheck.reason}). No miss recorded; task not marked processed for this assignee.`,
                        });
                        continue;
                    }

                    const rawDeadline = task.individualDeadline || task.deadline;
                    const dueAt = rawDeadline?.toDate
                        ? rawDeadline.toDate().toISOString()
                        : rawDeadline
                          ? new Date(rawDeadline).toISOString()
                          : null;
                    const { created } = await recordMiss(adminDb, {
                        taskId,
                        subjectUid: assigneeId,
                        subjectNameSnapshot: userData.displayName || userData.name || userData.email || assigneeId,
                        taskTitleSnapshot: taskTitle,
                        dueAt,
                    }, nowDate);
                    if (created) {
                        missRecordsCreated++;
                        // Neutral overdue notice: no warning, no penalty
                        // language (E.6.2).
                        notificationService.send(assigneeId, {
                            type: 'task_overdue',
                            title: 'Task Overdue',
                            body: `The deadline for "${taskTitle}" has passed.`,
                            link: `/profile/unified?uid=${assigneeId}`,
                            metadata: { taskId },
                        }, 'P1').catch(err => console.error('[cron/check-deadlines] Notification failed:', err));
                    }
                    recordedAssigneeCount++;
                } catch (assigneeError: any) {
                    // One bad assignee must not abort the rest of the batch.
                    failedDetails.push({
                        taskId,
                        title: taskTitle,
                        error: `assignee ${assigneeId}: ${assigneeError?.message || String(assigneeError)}`,
                    });
                }
                } // end per-assignee loop

                if (recordedAssigneeCount > 0) {
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

        // 4. Pattern evaluation at the END of the run (E.6.3).
        const referral = await evaluateReferralPatterns(adminDb, nowDate);

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
            warningsIssued: 0,
            blacklistsTriggered: 0,
            missRecordsCreated,
            referralDraftsCreated: referral.draftsCreated,
            referralDigestsSent: referral.digestsSent,
            skipped: skippedCount,
            skippedDetails,
            failed: failedCount,
            failedDetails,
            message: `Processed ${tasksProcessedCount} overdue task(s): ${missRecordsCreated} miss record(s) written, ${referral.draftsCreated} referral draft(s) created, ${skippedCount} skipped, ${failedCount} failed. No warnings are issued by this cron.`,
            governorTermSweep,
            customRoleExpirySweep,
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
