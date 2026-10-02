import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { taskId } = await params;

        if (!taskId) {
            return NextResponse.json({ error: 'Task ID required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
        }

        // Verify task exists
        const taskDoc = await db.collection('tasks').doc(taskId).get();
        if (!taskDoc.exists) {
            return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }

        // Fetch activities ordered by createdAt DESC
        const activitiesSnapshot = await db.collection('tasks').doc(taskId)
            .collection('activity')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        // Collect user IDs to fetch names
        const userIds = new Set<string>();
        const rawActivities: any[] = [];

        activitiesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            rawActivities.push({
                id: doc.id,
                type: data.type,
                userId: data.userId,
                data: data.data || {},
                createdAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toISOString() : null,
            });
            if (data.userId) userIds.add(data.userId);
        });

        // Fetch user names
        const userMap: Record<string, string> = {};
        for (const uid of Array.from(userIds)) {
            try {
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const d = userDoc.data();
                    userMap[uid] = d?.displayName || d?.email || 'Unknown';
                }
            } catch { }
        }

        // Enrich activities with user names
        const activities = rawActivities.map(a => ({
            ...a,
            userName: a.userId ? (userMap[a.userId] || 'Unknown') : 'System',
        }));

        console.log(`[Activity API] Returning ${activities.length} activities for task ${taskId}`);

        return NextResponse.json({
            activities,
            count: activities.length
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
    { params }: { params: Promise<{ taskId: string }> }
) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { taskId } = await params;
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
        const taskDoc = await db.collection('tasks').doc(taskId).get();
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

        // If this is rejection feedback, create a notification for the assignee
        if (data?.isRejectionFeedback && assigneeId && assigneeId !== auth.user.userId) {
            try {
                // Get the manager's name
                const managerDoc = await db.collection('users').doc(auth.user.userId).get();
                const managerName = managerDoc.exists
                    ? (managerDoc.data()?.displayName || 'Manager')
                    : 'Manager';

                const notifRef = db.collection('users').doc(assigneeId).collection('notifications').doc();
                await notifRef.set({
                    type: 'task_feedback',
                    title: 'Changes Requested',
                    body: `${managerName} requested changes on "${taskTitle}": ${(data.text || '').slice(0, 100)}${(data.text || '').length > 100 ? '...' : ''}`,
                    link: `/profile/unified`,
                    taskId: taskId,
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
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
