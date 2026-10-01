import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized, admin } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    if (!ensureAdminInitialized()) {
        return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
    }
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Db error' }, { status: 500 });

    // Auth header for CRON (Vercel Cron Secret or simple bearer)
    // Ensures only automated schedulers or superadmins can trigger this
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET || 'local-cron-secret'}`) {
        // Just for local testing/monitoring
        if (process.env.NODE_ENV === 'production') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    try {
        const dlqSnapshot = await db.collection('dlq_points_retry')
            .where('status', '==', 'PENDING_RETRY')
            .limit(50)
            .get();

        if (dlqSnapshot.empty) {
            return NextResponse.json({ message: 'DLQ is empty. No operations to retry.' });
        }

        const batch = db.batch();
        const results = [];

        for (const doc of dlqSnapshot.docs) {
            const data = doc.data();

            // Re-apply idempotently based on action
            if (data.action === 'task_approval_failed') {
                const taskId = data.taskId;
                const taskRef = db.collection('tasks').doc(taskId);
                const taskSnap = await taskRef.get();

                if (!taskSnap.exists) {
                    batch.update(doc.ref, { status: 'FAILED_PERMANENTLY', reason: 'Task not found' });
                    continue;
                }

                const updatesToApply = data.payload?.updatesToApply || {};
                const taskData = taskSnap.data()!;

                // Idempotency check: has the task ALREADY been successfully completed?
                if (taskData.status === 'completed') {
                    batch.update(doc.ref, { status: 'ALREADY_PROCESSED_IDEMPOTENTLY' });
                    continue;
                }

                // Apply the exact missed transaction logic!
                batch.update(taskRef, updatesToApply);

                const assigneeIds: string[] = Array.isArray(taskData.assigneeIds)
                    ? taskData.assigneeIds
                    : (taskData.assigneeId ? [String(taskData.assigneeId)] : []);

                const pointsToAward = typeof taskData.points === 'number' ? taskData.points : 0;

                if (updatesToApply.status === 'completed') {
                    batch.update(taskRef, { completedAt: admin.firestore.Timestamp.now() });

                    for (const uid of assigneeIds) {
                        const userRef = db.collection('users').doc(uid);

                        // Critical Idempotency Guard on the Ledger Level:
                        // Did this specific task completion already award points to this user somehow?
                        const ledgerQuery = await db.collection('points_ledger')
                            .where('user_id', '==', uid)
                            .where('task_id', '==', taskId)
                            .get();

                        if (ledgerQuery.empty) {
                            if (pointsToAward > 0) {
                                // Mathematical Delegation to Database!
                                batch.set(userRef, {
                                    total_points: admin.firestore.FieldValue.increment(pointsToAward),
                                    points: admin.firestore.FieldValue.increment(pointsToAward), // legacy fallback mapping
                                    tasksCompletedCount: admin.firestore.FieldValue.increment(1)
                                }, { merge: true });

                                // Unbreakable Ledger Log
                                const ledgerRef = db.collection('points_ledger').doc();
                                batch.set(ledgerRef, {
                                    user_id: uid,
                                    task_id: taskId,
                                    points_awarded: pointsToAward,
                                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                                    status: 'PROCESSED'
                                });
                            }
                        }
                    }
                }

                batch.update(doc.ref, { status: 'PROCESSED', processedAt: admin.firestore.FieldValue.serverTimestamp() });
                results.push({ id: doc.id, status: 'PROCESSED' });
            } else if (data.action === 'universal_review_approval_failed') {
                // Future Implementation for other queues, mark permanent currently
                batch.update(doc.ref, { status: 'FAILED_PERMANENTLY', reason: 'Universal review retry via batch temporarily constrained' });
            } else {
                batch.update(doc.ref, { status: 'FAILED_PERMANENTLY', reason: 'Unknown action' });
            }
        }

        await batch.commit();

        return NextResponse.json({ success: true, processed: results.length, results });

    } catch (error: any) {
        console.error('[DLQ Worker] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
