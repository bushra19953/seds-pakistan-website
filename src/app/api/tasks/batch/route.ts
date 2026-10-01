
import { NextRequest, NextResponse } from "next/server";
import { getDb, admin } from "@/lib/server/firebase-admin";
import { verifyAuthentication } from "@/lib/auth-middleware";
import { hasServerPermission } from "@/lib/server/permissions";

export async function DELETE(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
        }

        // 1. Authenticate
        const authResult = await verifyAuthentication(request);
        if (!authResult.authenticated || !authResult.user) {
            return NextResponse.json({ error: authResult.error || 'Unauthorized' }, { status: 401 });
        }
        const decoded = authResult.user.user;

        // 2. Permission Check (Admins only)
        const claims: any = decoded || {};
        let canManage = !!(
            (claims.permissions && claims.permissions.manageTasks === true) ||
            claims.manageTasks === true ||
            claims.canManageTasks === true
        );

        if (!canManage) {
            const roleSnap = await db.collection('roles').doc(claims.uid).get();
            const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
            canManage = await hasServerPermission(role, 'canManageTasks');
        }

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
        }

        // 3. Parse Body
        const body = await request.json();
        const { taskIds } = body;
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return NextResponse.json({ error: 'Invalid request: taskIds must be an array' }, { status: 400 });
        }

        // 4. Processing
        // We need to read them to update stats. Limit to 500 for Firestore batch size logic simplicity for now.
        if (taskIds.length > 500) {
            return NextResponse.json({ error: 'Batch size limit exceeded (max 500)' }, { status: 400 });
        }

        const tasksRef = db.collection('tasks');
        // We cannot use 'where in' for > 30 items usually. So we read by ID or just loop.
        // Iterating reads is safer for arbitrarily large lists than 'in' queries.

        // Aggregation for stats
        const assigneeDecrements: Record<string, number> = {};
        const completedDecrements: Record<string, number> = {};
        const batch = db.batch();
        let deleteCount = 0;

        // Read all tasks to be deleted
        const refs = taskIds.map(id => tasksRef.doc(id));
        const snapshots = await db.getAll(...refs);

        for (const snap of snapshots) {
            if (!snap.exists) continue;
            const data = snap.data();
            batch.delete(snap.ref);
            deleteCount++;

            // Stats Logic
            if (data?.assigneeId) {
                const uid = data.assigneeId;
                assigneeDecrements[uid] = (assigneeDecrements[uid] || 0) + 1;
                if (data.status === 'completed') {
                    completedDecrements[uid] = (completedDecrements[uid] || 0) + 1;
                }
            }
        }

        // Apply User Updates
        for (const [uid, count] of Object.entries(assigneeDecrements)) {
            const userRef = db.collection('users').doc(uid);
            const updates: any = {
                tasksAssignedCount: admin.firestore.FieldValue.increment(-count)
            };
            if (completedDecrements[uid]) {
                updates.tasksCompletedCount = admin.firestore.FieldValue.increment(-completedDecrements[uid]);
            }
            batch.set(userRef, updates, { merge: true });
        }

        await batch.commit();

        return NextResponse.json({ ok: true, deletedCount: deleteCount });

    } catch (error: any) {
        console.error('Batch Delete Error:', error);
        return NextResponse.json({ error: error.message || 'Batch delete failed' }, { status: 500 });
    }
}
