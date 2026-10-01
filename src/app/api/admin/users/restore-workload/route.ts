import { NextResponse, NextRequest } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { FieldValue } from 'firebase-admin/firestore';

export async function POST(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const decoded = auth.user.user;

        const canManage = await hasServerPermission(auth.user.role, 'canManageUsers');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden: Insufficient permissions to restore workload' }, { status: 403 });
        }

        const body = await req.json();
        const { uid } = body;

        if (!uid) {
            return NextResponse.json({ error: 'User UID is required' }, { status: 400 });
        }

        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
        }

        // Fetch tasks that were redirected FROM this user AND are still pending
        const snapshot = await db.collection('tasks')
            .where('redirectedFrom', '==', uid)
            .where('status', 'in', ['pending', 'locked', 'in_progress'])
            .get();

        if (snapshot.empty) {
            return NextResponse.json({ success: true, restoredCount: 0, message: 'No active redirected tasks found.' });
        }

        const batch = db.batch();
        let restoredCount = 0;

        snapshot.docs.forEach(doc => {
            const docRef = doc.ref;
            batch.update(docRef, {
                assigneeId: uid,
                redirectedFrom: FieldValue.delete(), // Clear the flag since it's now restored
                updatedAt: FieldValue.serverTimestamp()
            });

            // Log the reverse operation
            const activityRef = docRef.collection('activity').doc();
            batch.set(activityRef, {
                type: 'reassign',
                userId: decoded.uid,
                data: {
                    previousAssigneeId: doc.data().assigneeId,
                    newAssigneeId: uid,
                    reason: 'Bulk Workout Restore Engine (Return from Vacation)'
                },
                createdAt: FieldValue.serverTimestamp()
            });

            restoredCount++;
        });

        // Add a master audit log entry
        const auditRef = db.collection('audit_logs').doc();
        batch.set(auditRef, {
            action: 'restore_workload',
            actorId: decoded.uid,
            targetUid: uid,
            restoredTaskCount: restoredCount,
            timestamp: FieldValue.serverTimestamp()
        });

        await batch.commit();

        return NextResponse.json({
            success: true,
            restoredCount,
            message: `Successfully transferred ${restoredCount} tasks back.`
        });

    } catch (error: any) {
        console.error('[restore-workload] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
