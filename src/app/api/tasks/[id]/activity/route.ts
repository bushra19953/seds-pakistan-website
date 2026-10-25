import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
    getTaskDocViaSeam,
    getUserDocViaSeam,
    listActivityViaSeam,
    mirrorSetViaSeam,
} from '@/lib/supa/seam-tasks-lists';

export const dynamic = 'force-dynamic';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: taskId } = await params;

        if (!taskId) {
            return NextResponse.json({ error: 'Task ID required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
        }

        // Verify task exists (seam when the 'tasks' surface is ON; seam
        // null falls back to the Firestore get, unchanged)
        const seamTaskDoc = await getTaskDocViaSeam(taskId);
        const taskDoc = seamTaskDoc ?? await db.collection('tasks').doc(taskId).get();
        if (!taskDoc.exists) {
            return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }

        // Fetch activities ordered by createdAt DESC (the seam reads the
        // tasks/{id}/activity subcollection path, which the adapter maps
        // to its fs_group_activity landing table; the Firestore query is
        // the fallback, unchanged)
        const seamActivities = await listActivityViaSeam(taskId);
        const activitiesSnapshot: any = seamActivities ?? await db.collection('tasks').doc(taskId)
            .collection('activity')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        // Collect user IDs to fetch names
        const userIds = new Set<string>();
        const rawActivities: any[] = [];

        activitiesSnapshot.docs.forEach((doc: any) => {
            const data = doc.data();
            const createdAtMs = data.createdAt?.toDate?.() ? data.createdAt.toDate().getTime() : null;
            rawActivities.push({
                id: doc.id,
                type: data.type,
                userId: data.userId,
                data: data.data || {},
                createdAt: createdAtMs !== null ? new Date(createdAtMs).toISOString() : null,
                createdAtMs,
            });
            if (data.userId) userIds.add(data.userId);
        });

        // Per-assignee silence signals: last activity per assignee, days since last
        // activity, and whether the assignee has gone silent (> 2 days with no
        // activity while the task is still incomplete).
        const taskDataForSilence = taskDoc.data();
        const isTaskIncomplete = taskDataForSilence?.status !== 'completed';
        const taskCreatedAtMs = taskDataForSilence?.createdAt?.toDate?.()
            ? taskDataForSilence.createdAt.toDate().getTime()
            : null;
        const assigneeIdSet = new Set<string>();
        if (taskDataForSilence?.assigneeId) assigneeIdSet.add(String(taskDataForSilence.assigneeId));
        if (Array.isArray(taskDataForSilence?.assigneeIds)) {
            for (const aid of taskDataForSilence.assigneeIds) {
                if (aid) assigneeIdSet.add(String(aid));
            }
        }
        const assigneeIds = Array.from(assigneeIdSet);
        for (const aid of assigneeIds) userIds.add(aid);

        const lastActivityByUser = new Map<string, number>();
        for (const a of rawActivities) {
            if (!a.userId || a.createdAtMs === null) continue;
            const prev = lastActivityByUser.get(a.userId);
            if (prev === undefined || a.createdAtMs > prev) {
                lastActivityByUser.set(a.userId, a.createdAtMs);
            }
        }

        const nowMs = Date.now();
        const SILENCE_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;
        const assigneeSilence = assigneeIds.map(aid => {
            const lastMs = lastActivityByUser.get(aid) ?? taskCreatedAtMs;
            const lastActivityAt = lastMs !== null && lastMs !== undefined
                ? new Date(lastMs).toISOString()
                : null;
            const daysSinceLastActivity = lastMs !== null && lastMs !== undefined
                ? Math.round(((nowMs - lastMs) / (24 * 60 * 60 * 1000)) * 10) / 10
                : null;
            return {
                userId: aid,
                userName: aid,
                lastActivityAt,
                daysSinceLastActivity,
                hasGoneSilent: isTaskIncomplete && (
                    daysSinceLastActivity === null
                        ? true
                        : (nowMs - (lastMs as number)) > SILENCE_THRESHOLD_MS
                ),
            };
        });

        // Fetch user names
        const userMap: Record<string, string> = {};
        for (const uid of Array.from(userIds)) {
            try {
                const seamUserDoc = await getUserDocViaSeam(uid);
                const userDoc = seamUserDoc ?? await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const d = userDoc.data();
                    userMap[uid] = d?.displayName || d?.email || 'Unknown';
                }
            } catch { }
        }

        // Enrich activities with user names (createdAtMs is internal; keep the
        // public activity shape unchanged)
        const activities = rawActivities.map(({ createdAtMs, ...a }) => ({
            ...a,
            userName: a.userId ? (userMap[a.userId] || 'Unknown') : 'System',
        }));

        // Enrich silence signals with assignee names (assignees were added to
        // userIds above, so userMap covers them)
        const assigneeSilenceWithNames = assigneeSilence.map(s => ({
            ...s,
            userName: userMap[s.userId] || 'Unknown',
        }));

        console.log(`[Activity API] Returning ${activities.length} activities for task ${taskId}`);

        return NextResponse.json({
            activities,
            count: activities.length,
            assigneeSilence: assigneeSilenceWithNames,
        });

    } catch (error) {
        console.error('[Activity API] Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to fetch activities'
        }, { status: 500 });
    }
}

// POST: Create a new activity entry (comment/feedback)
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: taskId } = await params;
        const body = await request.json();
        const { type, data } = body;

        if (!taskId) {
            return NextResponse.json({ error: 'Task ID required' }, { status: 400 });
        }

        if (!type || !['comment', 'rejection', 'feedback'].includes(type)) {
            return NextResponse.json({ error: 'Invalid activity type' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
        }

        // Verify task exists and get assignee for notification
        const seamTaskDoc = await getTaskDocViaSeam(taskId);
        const taskDoc = seamTaskDoc ?? await db.collection('tasks').doc(taskId).get();
        if (!taskDoc.exists) {
            return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }

        const taskData = taskDoc.data();
        const assigneeId = taskData?.assigneeId;
        const taskTitle = taskData?.title || 'Task';

        // Create activity entry
        const admin = await import('firebase-admin');
        const activityRef = db.collection('tasks').doc(taskId).collection('activity').doc();
        await activityRef.set({
            type,
            userId: auth.user.userId,
            data: data || {},
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Mirror the write via the seam (flag ON only). The Firestore
        // serverTimestamp sentinel cannot cross into jsonb, so the mirror
        // carries an ISO string taken at the same moment; a mirror failure
        // never fails the request (mirrorSetViaSeam swallows errors).
        await mirrorSetViaSeam(`tasks/${taskId}/activity`, activityRef.id, {
            type,
            userId: auth.user.userId,
            data: data || {},
            createdAt: new Date().toISOString(),
        });

        // If this is rejection feedback, create a notification for the assignee
        if (data?.isRejectionFeedback && assigneeId && assigneeId !== auth.user.userId) {
            try {
                // Get the manager's name
                const seamManagerDoc = await getUserDocViaSeam(auth.user.userId);
                const managerDoc = seamManagerDoc ?? await db.collection('users').doc(auth.user.userId).get();
                const managerName = managerDoc.exists
                    ? (managerDoc.data()?.displayName || 'Manager')
                    : 'Manager';

                const notifRef = db.collection('users').doc(assigneeId).collection('notifications').doc();
                const notifBody = `${managerName} requested changes on "${taskTitle}": ${(data.text || '').slice(0, 100)}${(data.text || '').length > 100 ? '...' : ''}`;
                await notifRef.set({
                    type: 'task_feedback',
                    title: 'Changes Requested',
                    body: notifBody,
                    link: `/profile/unified`,
                    taskId: taskId,
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                });

                // Mirror the notification write via the seam (flag ON
                // only; ISO string instead of the serverTimestamp
                // sentinel; failure never fails the request).
                await mirrorSetViaSeam(`users/${assigneeId}/notifications`, notifRef.id, {
                    type: 'task_feedback',
                    title: 'Changes Requested',
                    body: notifBody,
                    link: `/profile/unified`,
                    taskId: taskId,
                    isRead: false,
                    timestamp: new Date().toISOString(),
                });

                console.log(`[Activity API] Created notification for assignee ${assigneeId}`);
            } catch (notifError) {
                console.error('[Activity API] Failed to create notification:', notifError);
                // Don't fail the whole request just because notification failed
            }
        }

        console.log(`[Activity API] Created ${type} activity for task ${taskId}`);

        return NextResponse.json({
            success: true,
            activityId: activityRef.id
        });

    } catch (error) {
        console.error('[Activity API] POST Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to create activity'
        }, { status: 500 });
    }
}
