import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { NextRequest } from 'next/server';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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
            return NextResponse.json({ message: 'Auto-issue on deadline miss is disabled.' });
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

        const docsToProcess = overdueDocs.filter(doc => {
            const data = doc.data();
            return data.overdueProcessed !== true && (data.status === 'pending' || data.status === 'in-progress');
        });
        
        const alreadyProcessedCount = overdueDocs.length - docsToProcess.length;

        if (docsToProcess.length === 0) {
            if (overdueDocs.length > 0) {
                return NextResponse.json({ 
                    message: `All ${alreadyProcessedCount} currently overdue tasks have already been processed and penalized previously.` 
                });
            }
            return NextResponse.json({ message: 'No overdue tasks found.' });
        }

        let warningCount = 0;
        let blacklistCount = 0;

        for (const taskDoc of docsToProcess) {
            const task = taskDoc.data();
            const taskId = taskDoc.id;
            // Every assignee (doer and oversight) is accountable for the deadline.
            const assigneeIds: string[] = Array.isArray(task.assigneeIds) && task.assigneeIds.length
                ? task.assigneeIds.map(String).filter(Boolean)
                : (task.assigneeId ? [String(task.assigneeId)] : []);

            if (assigneeIds.length === 0) continue;

            // Mark task as overdue
            await taskDoc.ref.update({
                status: 'overdue',
                overdueProcessed: true,
                updatedAt: now,
            });

            for (const assigneeId of assigneeIds) {
            // Read user doc to get current count
            const userRef = usersRef.doc(assigneeId);
            const userDoc = await userRef.get();
            if (!userDoc.exists) continue;

            const userData = userDoc.data()!;
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
                    title: '⚠️ Deadline Missed — Warning Issued',
                    body: `You missed the deadline for "${task.title || 'Task'}" and received a warning + ${effectivePenalty} point penalty.`,
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
                    title: '🚫 Account Blacklisted',
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
            } // end per-assignee loop
        }

        return NextResponse.json({
            success: true,
            processed: snapshot.size,
            warningsIssued: warningCount,
            blacklistsTriggered: blacklistCount,
            settings: {
                expirationDays: warnSettings.expirationDays,
                blacklistThreshold,
                penaltyPoints,
            },
        });

    } catch (error: any) {
        console.error('[cron/check-deadlines] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
