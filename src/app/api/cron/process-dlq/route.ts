import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, admin } from '@/lib/server/firebase-admin';
import { getG3Db } from '@/lib/server/cron/g3-data';
import { isSupaPrimary } from '@/lib/supa/flags';
import { applyPointsAwardViaSupa, type PointsAwardInput } from '@/lib/supa/gamification';
import {
  flushPendingUsersPrimaryOps,
  identityPrimaryFlagOn,
  primaryIdentitySet,
  type PendingUsersPrimaryOp,
} from '@/lib/server/supa-identity-primary';


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
    const db = getG3Db();
    if (!db) return NextResponse.json({ error: 'Db error' }, { status: 500 });

    // Auth: CRON_SECRET bearer only, fail-closed in all environments.
    // An unset/empty secret is a server misconfiguration (500); a
    // missing or mismatched bearer is rejected (401) unconditionally.
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
    }
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
        const dueDocs = dlqSnapshot.docs.filter((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
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
        const pendingUsersPrimary: PendingUsersPrimaryOp[] = [];
        // C-07: under gamification Supa-primary, retried completion
        // awards are queued here and claimed via apply_points_award
        // after the batch commits (the RPC claim replaces the
        // points_ledger count() guard below as the Supa-side guard).
        const supaGamePrimary = isSupaPrimary('gamification');
        const pendingGameAwards: PointsAwardInput[] = [];
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
                            if (supaGamePrimary) {
                                // C-07 guard swap: no Firestore ledger
                                // count, no Firestore counters/ledger —
                                // the RPC claim post-commit is the guard
                                // and the award. Zero-points completions
                                // write nothing today, so nothing queues.
                                if (pointsToAward > 0) {
                                    pendingGameAwards.push({
                                        taskId: String(taskId),
                                        userId: uid,
                                        action: 'COMPLETION',
                                        points: pointsToAward,
                                        countCompletion: true,
                                        onTime: null,
                                    });
                                }
                                continue;
                            }
                            const userRef = db.collection('users').doc(uid);

                            // Critical Idempotency Guard on the Ledger Level:
                            // Did this specific task completion already award points to this user somehow?
                            // Only existence matters here, so a count()
                            // aggregation replaces the full document fetch
                            // (count == 0 is exactly the old .empty check).
                            const ledgerCount = await db.collection('points_ledger')
                                .where('user_id', '==', uid)
                                .where('task_id', '==', taskId)
                                .count()
                                .get();

                            if (ledgerCount.data().count === 0) {
                                if (pointsToAward > 0) {
                                    // Mathematical Delegation to Database!
                                    const dlqPointsPayload = {
                                        total_points: admin.firestore.FieldValue.increment(pointsToAward),
                                        points: admin.firestore.FieldValue.increment(pointsToAward), // legacy fallback mapping
                                        tasksCompletedCount: admin.firestore.FieldValue.increment(1)
                                    };
                                    batch.set(userRef, dlqPointsPayload, { merge: true });
                                    // WRITE PRIMACY (G-USER-5, U-35):
                                    // queued as a primary RMW op; the
                                    // ledger-existence guard above is
                                    // what makes a retry safe on both
                                    // stores.
                                    pendingUsersPrimary.push({ uid, payload: dlqPointsPayload });

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

        // WRITE PRIMACY flush (U-35): primary RMW ops before commit.
        await flushPendingUsersPrimaryOps(pendingUsersPrimary);
        await batch.commit();

        // C-07: claim the queued awards on the Supa primary now that
        // the retry batch has committed. Duplicates are the guard
        // working; a null result is logged for operator replay.
        for (const award of pendingGameAwards) {
            const awardResult = await applyPointsAwardViaSupa(award);
            if (awardResult === null) {
                logDlq('gamification_award_not_landed', { taskId: award.taskId, userId: award.userId, action: award.action });
            }
        }

        logDlq('run_finished', { pending: dlqSnapshot.size, due: dueDocs.length, outcomes: outcomeCounts });

        return NextResponse.json({ success: true, due: dueDocs.length, outcomes: outcomeCounts, results });

    } catch (error: any) {
        logDlq('run_failed', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
