import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * PROACTIVE DEADLINE REMINDER CRON
 * Runs periodically to alert users 24 hours before their task is due.
 */
export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get('Authorization');
        const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;

        if (!isCron) {
            const auth = await verifyAuthentication(req);
            if (!auth.authenticated || !auth.user?.role) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
        }

        if (!ensureAdminInitialized()) return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const now = Date.now();
        const tomorrow = now + 24 * 60 * 60 * 1000;
        const tomorrowPlusMargin = tomorrow + 60 * 60 * 1000; // 1 hour margin

        const tasksRef = db.collection('tasks');

        // Find tasks due in roughly 24 hours. The sent-flag is checked in
        // code because a '!=' query would skip legacy docs that lack the
        // field entirely.
        const snapshot = await tasksRef
            .where('status', 'in', ['pending', 'in-progress'])
            .where('deadline', '>=', new Date(tomorrow - 60 * 60 * 1000))
            .where('deadline', '<=', new Date(tomorrowPlusMargin))
            .get();

        if (snapshot.empty) {
            return NextResponse.json({ message: 'No upcoming deadlines for reminders.' });
        }

        const batch = db.batch();
        let reminderCount = 0;

        for (const doc of snapshot.docs) {
            const task = doc.data();
            if (task.reminderSent24h === true) continue;
            const assigneeIds: string[] = Array.isArray(task.assigneeIds)
                ? task.assigneeIds
                : (task.assigneeId ? [task.assigneeId] : []);

            if (assigneeIds.length === 0) continue;

            for (const uid of assigneeIds) {
                notificationService.send(uid, {
                    type: 'deadline_reminder',
                    title: '⏳ 24h Deadline Warning',
                    body: `The deadline for "${task.title || 'Task'}" is in 24 hours. Please ensure your submission is ready!`,
                    link: `/tasks/${doc.id}`,
                    metadata: { taskId: doc.id }
                }, 'P1').catch(err => console.error('[reminders] Notification failed:', err));
            }

            batch.update(doc.ref, { reminderSent24h: true });
            reminderCount++;
        }

        await batch.commit();

        return NextResponse.json({
            success: true,
            remindersSent: reminderCount
        });

    } catch (error: any) {
        console.error('Error sending reminders:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
