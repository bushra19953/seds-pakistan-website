import { NextRequest, NextResponse } from 'next/server';
import { getDb, ensureAdminInitialized, admin } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';

// --- DLQ retry policy tunables ---
const MAX_ATTEMPTS = 5;                  // park permanently after this many tries
const BACKOFF_BASE_MS = 5 * 60 * 1000;   // 5 minutes, doubled per attempt
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours ceiling
const DLQ_FETCH_LIMIT = 50;

// Terminal statuses:
// - PROCESSED                 : retry succeeded
// - ALREADY_PROCESSED_IDEMPOTENTLY : target was already in the desired state
// - FAILED_PERMANENTLY        : max attempts used up, or target is gone
// - NEEDS_MANUAL_REVIEW       : processor lacks enough context to retry safely

function backoffMs(attemptsSoFar: number): number {
    const ms = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptsSoFar));
    return Math.min(ms, BACKOFF_MAX_MS);
}

function logDlq(event: string, fields: Record<string, unknown>) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        source: 'dlq-worker',
        event,
        ...fields,
    }));
}

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

    const now = Date.now();

    try {
        const dlqSnapshot = await db.collection('dlq_points_retry')
            .where('status', '==', 'PENDING_RETRY')
            .limit(DLQ_FETCH_LIMIT)
            .get();

        if (dlqSnapshot.empty) {
            logDlq('run_finished', { pending: 0, processed: 0 });
            return NextResponse.json({ message: 'DLQ is empty. No operations to retry.' });
        }

        // Backoff gate: only pick up docs whose nextRetryAt has passed (or was never set).
        const dueDocs = dlqSnapshot.docs.filter((doc) => {
            const nextRetryAt = doc.data().nextRetryAt;
            if (!nextRetryAt || typeof nextRetryAt.toMillis !== 'function') return true;
            return nextRetryAt.toMillis() <= now;
        });

        if (dueDocs.length === 0) {
            logDlq('run_finished', {
                pending: dlqSnapshot.size,
                due: 0,
                note: 'All pending jobs are still in backoff',
            });
            return NextResponse.json({
                message: 'DLQ has pending jobs but all are in backoff. Nothing due.',
                pending: dlqSnapshot.size,
            });
        }

        logDlq('run_started', { pending: dlqSnapshot.size, due: dueDocs.length });

        const batch = db.batch();
        const results: Array<Record<string, unknown>> = [];
        const outcomeCounts: Record<string, number> = {};

        const trackOutcome = (entry: Record<string, unknown>) => {
            results.push(entry);
            const s = String(entry.status || 'unknown');
            outcomeCounts[s] = (outcomeCounts[s] || 0) + 1;
        };

        for (const doc of dueDocs) {
            const data = doc.data();
            const action = typeof data.action === 'string' ? data.action : 'unknown';
            const attemptsSoFar = typeof data.attempts === 'number' && data.attempts >= 0 ? data.attempts : 0;
            const thisAttempt = attemptsSoFar + 1;
            const baseFields = { id: doc.id, action, attempt: thisAttempt };

            const scheduleRetry = (error: unknown) => {
                const errMsg = error instanceof Error ? error.message : String(error);
                if (thisAttempt >= MAX_ATTEMPTS) {
                    batch.update(doc.ref, {
                        status: 'FAILED_PERMANENTLY',
                        reason: `Max attempts reached (${MAX_ATTEMPTS}). Last error: ${errMsg}`,
                        attempts: thisAttempt,
                        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastError: errMsg,
                        parkedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    logDlq('parked_permanent', { ...baseFields, attempts: thisAttempt, lastError: errMsg });
                    trackOutcome({ ...baseFields, status: 'FAILED_PERMANENTLY', lastError: errMsg });
                } else {
                    const delay = backoffMs(attemptsSoFar);
                    batch.update(doc.ref, {
                        status: 'PENDING_RETRY',
                        attempts: thisAttempt,
                        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastError: errMsg,
                        nextRetryAt: admin.firestore.Timestamp.fromMillis(now + delay),
                    });
                    logDlq('retry_scheduled', { ...baseFields, attempts: thisAttempt, lastError: errMsg, nextRetryInMs: delay });
                    trackOutcome({ ...baseFields, status: 'RETRY_SCHEDULED', nextRetryInMs: delay, lastError: errMsg });
                }
            };

            // Attempt cap: jobs that already used up their tries get parked before reprocessing.
            if (attemptsSoFar >= MAX_ATTEMPTS) {
                const errMsg = `Attempt cap already reached (${attemptsSoFar}/${MAX_ATTEMPTS}); parking without another try`;
                batch.update(doc.ref, {
                    status: 'FAILED_PERMANENTLY',
                    reason: errMsg,
                    parkedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                logDlq('parked_permanent', { ...baseFields, attempt: attemptsSoFar, lastError: errMsg });
                trackOutcome({ ...baseFields, status: 'FAILED_PERMANENTLY', lastError: errMsg });
                continue;
            }

            try {
                // Re-apply idempotently based on action
                if (action === 'task_approval_failed') {
                    const taskId = data.taskId;
                    const taskRef = db.collection('tasks').doc(taskId);
                    const taskSnap = await taskRef.get();

                    if (!taskSnap.exists) {
                        batch.update(doc.ref, {
                            status: 'FAILED_PERMANENTLY',
                            reason: 'Task not found; nothing to retry against',
                            attempts: thisAttempt,
                            parkedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                        logDlq('parked_permanent', { ...baseFields, reason: 'task_not_found', taskId });
                        trackOutcome({ ...baseFields, status: 'FAILED_PERMANENTLY', reason: 'task_not_found' });
                        continue;
                    }

                    const updatesToApply = data.payload?.updatesToApply || {};
                    const taskData = taskSnap.data()!;

                    // Idempotency check: has the task ALREADY been successfully completed?
                    if (taskData.status === 'completed') {
                        batch.update(doc.ref, {
                            status: 'ALREADY_PROCESSED_IDEMPOTENTLY',
                            attempts: thisAttempt,
                            processedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                        logDlq('already_processed', { ...baseFields, taskId });
                        trackOutcome({ ...baseFields, status: 'ALREADY_PROCESSED_IDEMPOTENTLY' });
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

                    batch.update(doc.ref, {
                        status: 'PROCESSED',
                        attempts: thisAttempt,
                        processedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    logDlq('processed', { ...baseFields, taskId });
                    trackOutcome({ ...baseFields, status: 'PROCESSED' });
                } else if (action === 'gamification_tx_failed') {
                    // Cannot be auto-retried safely: the DLQ record carries taskId and
                    // payload.updatesToApply, but executeGamificationTransaction also needs
                    // the actorUid (written into audit records) and the original taskBefore,
                    // neither of which the writer stored. Park for manual replay instead of
                    // misfiring a blind transaction.
                    const reason = 'Retry needs actorUid/taskBefore context that the DLQ record does not carry; replay via executeGamificationTransaction manually';
                    batch.update(doc.ref, {
                        status: 'NEEDS_MANUAL_REVIEW',
                        reason,
                        attempts: thisAttempt,
                        parkedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    logDlq('needs_manual_review', { ...baseFields, taskId: data.taskId, reason });
                    trackOutcome({ ...baseFields, status: 'NEEDS_MANUAL_REVIEW', reason });
                } else if (action === 'universal_review_approval_failed') {
                    // No payload is stored on the record (ids only), so there is nothing
                    // safe to replay. Park for manual review.
                    const reason = 'Retry unsupported: DLQ record stores ids only, no payload to replay';
                    batch.update(doc.ref, {
                        status: 'NEEDS_MANUAL_REVIEW',
                        reason,
                        attempts: thisAttempt,
                        parkedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    logDlq('needs_manual_review', { ...baseFields, ids: data.ids, reason });
                    trackOutcome({ ...baseFields, status: 'NEEDS_MANUAL_REVIEW', reason });
                } else {
                    const reason = `Unknown action '${action}'; no retry handler defined`;
                    batch.update(doc.ref, {
                        status: 'NEEDS_MANUAL_REVIEW',
                        reason,
                        attempts: thisAttempt,
                        parkedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    logDlq('needs_manual_review', { ...baseFields, reason });
                    trackOutcome({ ...baseFields, status: 'NEEDS_MANUAL_REVIEW', reason });
                }
            } catch (docError: any) {
                // Isolate failures per doc: one bad record must not abort the whole batch.
                scheduleRetry(docError);
            }
        }

        await batch.commit();

        logDlq('run_finished', { pending: dlqSnapshot.size, due: dueDocs.length, outcomes: outcomeCounts });

        return NextResponse.json({ success: true, due: dueDocs.length, outcomes: outcomeCounts, results });

    } catch (error: any) {
        logDlq('run_failed', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
