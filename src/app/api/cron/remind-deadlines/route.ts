import { isCronRequest } from '@/lib/server/cron-auth';
import { NextResponse } from 'next/server';
import { ensureAdminInitialized } from '@/lib/server/firebase-admin';
import {
    getCronG1Db,
    queryAcceptanceTasks,
    queryDueSoonTasks,
} from '@/lib/server/cron/g1-data';
import { notificationService } from '@/lib/server/notification-service';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { NextRequest } from 'next/server';
import admin from 'firebase-admin';

export const dynamic = 'force-dynamic';

/**
 * PROACTIVE DEADLINE REMINDER CRON
 * Runs periodically to:
 *  1. Alert users 24 hours before their task deadline.
 *  2. Nudge assignees who never accepted their task (acceptance handshake
 *     was sent at assignment time but some users, e.g. Fahad Oct 10, go
 *     silent; nothing followed up until this cron existed).
 *
 * Shared by GET (Vercel Cron Jobs call cron paths with GET) and POST
 * (manual/admin trigger).
 *
 * Idempotency: each pass records a sent flag AND a server timestamp on the
 * task document. A re-run skips tasks already marked. Flags are only set
 * after every assignee send resolves; if any send rejects, the flag is
 * withheld and the error is stamped on the task so a re-run retries.
 */

// Assignees get one acceptance nudge if they still have not accepted the
// task a full day after it was assigned to them.
const ACCEPTANCE_NUDGE_GRACE_MS = 24 * 60 * 60 * 1000;

async function runDeadlineReminders(req: NextRequest) {
    try {
        const authHeader = req.headers.get('Authorization');
        const isCron = isCronRequest(authHeader);

        if (!isCron) {
            const auth = await verifyAuthentication(req);
            if (!auth.authenticated || !auth.user?.role) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
        }

        if (!ensureAdminInitialized()) return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        const db = getCronG1Db();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const now = Date.now();
        const tomorrow = now + 24 * 60 * 60 * 1000;
        const tomorrowPlusMargin = tomorrow + 60 * 60 * 1000; // 1 hour margin

        let remindersSent = 0;
        let remindersSkipped = 0;
        let remindersFailed = 0;
        let nudgesSent = 0;
        let nudgesSkipped = 0;

        // ------------------------------------------------------------------
        // PASS 1: 24h deadline reminders.
        // ------------------------------------------------------------------
        // Find tasks due in roughly 24 hours. Sent-flags are checked in code
        // because a '!=' query would skip legacy docs that lack the field
        // entirely.
        const dueSoonSnapshot = await queryDueSoonTasks(
            db,
            new Date(tomorrow - 60 * 60 * 1000),
            new Date(tomorrowPlusMargin),
        );

        for (const doc of dueSoonSnapshot.docs) {
            const task = doc.data();

            // Idempotency: skip if already reminded on a previous run.
            // Checks both the legacy boolean and the new timestamp (docs
            // written by older code may only carry the boolean).
            if (task.reminderSent24h === true || task.reminder24hSentAt) {
                remindersSkipped++;
                continue;
            }

            const assigneeIds: string[] = Array.isArray(task.assigneeIds)
                ? task.assigneeIds
                : (task.assigneeId ? [task.assigneeId] : []);

            if (assigneeIds.length === 0) {
                remindersSkipped++;
                continue;
            }

            const deadlineDate = task.deadline?.toDate ? task.deadline.toDate() : null;
            const deadlineLabel = deadlineDate ? deadlineDate.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) : 'in 24 hours';

            // Await every send. The flag is only committed after ALL sends
            // resolve, so a failure retries on the next run instead of being
            // swallowed by a flag written too early.
            const sendErrors: string[] = [];
            await Promise.all(assigneeIds.map(async (uid) => {
                try {
                    await notificationService.send(uid, {
                        type: 'deadline_reminder',
                        title: '24h Deadline Reminder',
                        body: `The deadline for "${task.title || 'Task'}" is ${deadlineLabel}. Please make sure your submission is ready.`,
                        link: `/tasks/${doc.id}`,
                        metadata: { taskId: doc.id }
                    }, 'P1');
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    sendErrors.push(`${uid}: ${msg}`);
                    console.error(`[reminders] Notification failed for ${uid} (task ${doc.id}):`, err);
                }
            }));

            if (sendErrors.length === 0) {
                await doc.ref.update({
                    reminderSent24h: true,
                    reminder24hSentAt: admin.firestore.FieldValue.serverTimestamp(),
                    reminder24hError: admin.firestore.FieldValue.delete(),
                    reminder24hErrorAt: admin.firestore.FieldValue.delete(),
                });
                remindersSent++;
            } else {
                // Partial or total failure: do NOT set the sent flag, stamp
                // the error so the next run retries and the failure is visible.
                await doc.ref.update({
                    reminder24hError: sendErrors.join(' | '),
                    reminder24hErrorAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                remindersFailed++;
            }
        }

        // ------------------------------------------------------------------
        // PASS 2: Acceptance nudges for users who never accepted their task.
        // ------------------------------------------------------------------
        // Tasks whose acceptance handshake is still 'pending-acceptance'
        // after a full day get one nudge. Legacy docs that predate the
        // acceptance handshake (no acceptanceStatus field) are deliberately
        // excluded: we cannot tell whether the assignee saw the assignment
        // through another channel, and nudging old tasks risks spam.
        const acceptanceSnapshot = await queryAcceptanceTasks(db);

        for (const doc of acceptanceSnapshot.docs) {
            const task = doc.data();

            // Idempotency: one nudge per task.
            if (task.acceptanceNudgeSent === true || task.acceptanceNudgeSentAt) {
                nudgesSkipped++;
                continue;
            }

            const createdDate = task.createdAt?.toDate ? task.createdAt.toDate() : null;
            if (!createdDate || (now - createdDate.getTime()) < ACCEPTANCE_NUDGE_GRACE_MS) {
                // Not yet a day old: give the assignee the grace period.
                continue;
            }

            const assigneeIds: string[] = Array.isArray(task.assigneeIds)
                ? task.assigneeIds
                : (task.assigneeId ? [task.assigneeId] : []);

            if (assigneeIds.length === 0) {
                nudgesSkipped++;
                continue;
            }

            const assignedLabel = createdDate.toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi' });

            const sendErrors: string[] = [];
            await Promise.all(assigneeIds.map(async (uid) => {
                try {
                    await notificationService.send(uid, {
                        type: 'acceptance_nudge',
                        title: 'Task Acceptance Pending',
                        body: `You were assigned "${task.title || 'Task'}" on ${assignedLabel} and have not accepted it yet. Please accept or decline it from your tasks page.`,
                        link: `/tasks/${doc.id}`,
                        metadata: { taskId: doc.id }
                    }, 'P1');
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    sendErrors.push(`${uid}: ${msg}`);
                    console.error(`[reminders] Acceptance nudge failed for ${uid} (task ${doc.id}):`, err);
                }
            }));

            if (sendErrors.length === 0) {
                await doc.ref.update({
                    acceptanceNudgeSent: true,
                    acceptanceNudgeSentAt: admin.firestore.FieldValue.serverTimestamp(),
                    acceptanceNudgeError: admin.firestore.FieldValue.delete(),
                    acceptanceNudgeErrorAt: admin.firestore.FieldValue.delete(),
                });
                nudgesSent++;
            } else {
                await doc.ref.update({
                    acceptanceNudgeError: sendErrors.join(' | '),
                    acceptanceNudgeErrorAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                console.error(`[reminders] Acceptance nudge partially failed for task ${doc.id}:`, sendErrors);
            }
        }

        return NextResponse.json({
            success: true,
            reminders: { sent: remindersSent, skipped: remindersSkipped, failed: remindersFailed },
            acceptanceNudges: { sent: nudgesSent, skipped: nudgesSkipped }
        });

    } catch (error: any) {
        console.error('Error sending reminders:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// Vercel Cron Jobs invoke the path with GET.
export async function GET(req: NextRequest) {
    return runDeadlineReminders(req);
}

// Manual / admin-triggered invocation.
export async function POST(req: NextRequest) {
    return runDeadlineReminders(req);
}
