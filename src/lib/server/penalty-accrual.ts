/**
 * penalty-accrual.ts - geometric hourly deadline penalty
 * (Founder-approved design, 2026-11-06; second-brain Orders 47/48
 * Item A).
 *
 * While a task or workflow step sits past its deadline UNSUBMITTED
 * (status pending, in-progress, or overdue), its penalty accrues by
 * the hour on a doubling schedule:
 *
 *   hour 1: 2 pts, hour 2: 4, hour 3: 8, hour 4: 16, hour 5: 32, ...
 *
 * strictly capped at the task's own penaltyPoints value, so the full
 * cap is consumed in about 4-5 hours for typical caps. Accrual is
 * settled by runPenaltyAccrual, hosted as a named step of the daily
 * /api/cron/overdue run: each run computes the schedule target for the
 * whole hours elapsed since the deadline and deducts only the DELTA
 * over what has already been applied, per assignee.
 *
 * Deadline fairness is structural, not a special case:
 *   - Submission freezes the clock. A task in submitted-for-review
 *     status is outside the accrual scan, and a task carrying proof
 *     (deliverableFiles) is skipped even if its status has not caught
 *     up (the Bug 4 guard). Time waiting on a reviewer is never
 *     charged to the assignee.
 *   - Approved leave exempts: an assignee whose granted leave covers
 *     the deadline accrues nothing (the same precedence invariant
 *     check-deadlines applies before recording a miss).
 *   - Accrued points are REAL deductions from the member's point
 *     balance (total_points / points), one points_ledger row per
 *     increment. The completion transaction therefore applies only
 *     the REMAINING penalty (cap minus already-accrued for that
 *     assignee), so a task can never cost more than its penaltyPoints
 *     in total across accrual and completion.
 *
 * Per-assignee accrual state lives on the task doc:
 *   penaltyAccrual: { [uid]: { applied, targetAccrued, hoursOverdue, updatedAt } }
 * `applied` counts points ACTUALLY deducted (a deduction is limited by
 * the member's current balance; any undeducted remainder stays owed
 * and is retried on later runs and at completion).
 *
 * Idempotency: the per-(task, assignee) state and the deterministic
 * ledger doc id (accrual_<taskId>_<uid>_<appliedTotal>) advance inside
 * one Firestore transaction with all reads before all writes, so a
 * retried run or transaction replays as a no-op delta.
 */
import { effectiveDeadlineMs } from '@/lib/deadline-fairness';
import {
    accruedPenaltyFor,
    accruedPenaltyForHours,
    wholeHoursOverdue,
} from '@/lib/penalty-schedule';
import { taskHasProofUploaded } from './bug4-proof-guards';
import { isExemptFromDeadlinePenalty } from './leave-exemption';

// The schedule math lives in the pure module (shared with the
// completion transaction); re-exported here for this pass's callers.
export { accruedPenaltyFor, accruedPenaltyForHours, wholeHoursOverdue };

export const PENALTY_ACCRUAL_ACTION = 'PENALTY_ACCRUAL';

/** Statuses in which an unsubmitted task keeps accruing. */
export const ACCRUAL_STATUSES = ['pending', 'in-progress', 'overdue'];

export interface PenaltyAccrualSummary {
    scanned: number;
    tasksCharged: number;
    assigneesCharged: number;
    totalDeducted: number;
    skippedProof: number;
    skippedNoPenalty: number;
    skippedNotDue: number;
    skippedLeaveExempt: number;
    failed: number;
}

function assigneeIdsOf(task: any): string[] {
    const raw = Array.isArray(task?.assigneeIds) && task.assigneeIds.length
        ? task.assigneeIds
        : task?.assigneeId
          ? [task.assigneeId]
          : [];
    return raw.map(String).filter(Boolean);
}

/**
 * One accrual settlement pass over every unsubmitted past-deadline
 * task. Takes the caller's Firestore handle (the discipline services
 * pattern) so it is testable against a fake db. One bad task never
 * aborts the pass.
 */
export async function runPenaltyAccrual(db: any, now: Date): Promise<PenaltyAccrualSummary> {
    const summary: PenaltyAccrualSummary = {
        scanned: 0,
        tasksCharged: 0,
        assigneesCharged: 0,
        totalDeducted: 0,
        skippedProof: 0,
        skippedNoPenalty: 0,
        skippedNotDue: 0,
        skippedLeaveExempt: 0,
        failed: 0,
    };
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const snap = await db
        .collection('tasks')
        .where('status', 'in', [...ACCRUAL_STATUSES])
        .get();
    summary.scanned = snap.size ?? snap.docs.length;

    for (const doc of snap.docs) {
        const task = doc.data() || {};
        try {
            if (taskHasProofUploaded(task)) {
                summary.skippedProof++;
                continue;
            }
            const cap = typeof task.penaltyPoints === 'number' ? task.penaltyPoints : 0;
            if (!(cap > 0)) {
                summary.skippedNoPenalty++;
                continue;
            }
            const deadlineMs = effectiveDeadlineMs(task);
            if (deadlineMs === null || deadlineMs >= nowMs) {
                summary.skippedNotDue++;
                continue;
            }
            const hours = wholeHoursOverdue(deadlineMs, nowMs);
            const target = accruedPenaltyForHours(hours, cap);
            if (target <= 0) continue;

            const assigneeIds = assigneeIdsOf(task);
            if (assigneeIds.length === 0) continue;

            // Leave exemption is judged BEFORE any charge, per
            // assignee, from granted leave records (the check-deadlines
            // precedence invariant). An all-exempt task is left
            // untouched so it is revisited after the leave ends.
            const chargeable: string[] = [];
            for (const uid of assigneeIds) {
                const leave = await isExemptFromDeadlinePenalty(db, uid, task);
                if (leave.exempt) summary.skippedLeaveExempt++;
                else chargeable.push(uid);
            }
            if (chargeable.length === 0) continue;

            // Per-attempt counters reset at the top of the callback: a
            // retried transaction attempt must not double-count the
            // summary (the writes themselves are delta-guarded).
            const attempt = { assignees: 0, deducted: 0 };
            const charged = await db.runTransaction(async (tx: any) => {
                attempt.assignees = 0;
                attempt.deducted = 0;
                // ALL READS first (Firestore transaction rule).
                const tSnap = await tx.get(doc.ref);
                if (!tSnap.exists) return false;
                const fresh = tSnap.data() || {};
                const status = String(fresh.status || '').toLowerCase();
                if (!ACCRUAL_STATUSES.includes(status)) return false; // submitted or completed meanwhile: frozen
                if (taskHasProofUploaded(fresh)) return false;
                const freshDeadlineMs = effectiveDeadlineMs(fresh);
                if (freshDeadlineMs === null) return false;
                const freshHours = wholeHoursOverdue(freshDeadlineMs, nowMs);
                const freshCap = typeof fresh.penaltyPoints === 'number' ? fresh.penaltyPoints : 0;
                const freshTarget = accruedPenaltyForHours(freshHours, freshCap);
                if (freshTarget <= 0) return false;

                const userSnaps = new Map<string, any>();
                for (const uid of chargeable) {
                    userSnaps.set(uid, await tx.get(db.collection('users').doc(uid)));
                }

                // ALL WRITES.
                const accrual: Record<string, any> = { ...(fresh.penaltyAccrual || {}) };
                let changed = false;
                for (const uid of chargeable) {
                    const uSnap = userSnaps.get(uid);
                    if (!uSnap?.exists) continue;
                    const already = accruedPenaltyFor(fresh, uid);
                    const delta = freshTarget - already;
                    if (delta <= 0) continue;
                    const u = uSnap.data() || {};
                    const balance = typeof u.total_points === 'number'
                        ? u.total_points
                        : typeof u.points === 'number'
                          ? u.points
                          : 0;
                    const deducted = Math.min(delta, Math.max(0, balance));
                    const newApplied = already + deducted;
                    accrual[uid] = {
                        applied: newApplied,
                        targetAccrued: freshTarget,
                        hoursOverdue: freshHours,
                        updatedAt: nowIso,
                    };
                    changed = true;
                    if (deducted > 0) {
                        const pointsBalance = typeof u.points === 'number' ? u.points : balance;
                        tx.update(uSnap.ref, {
                            total_points: balance - deducted,
                            points: Math.max(0, pointsBalance - deducted),
                        });
                        tx.set(db.collection('points_ledger').doc(`accrual_${doc.id}_${uid}_${newApplied}`), {
                            user_id: uid,
                            task_id: doc.id,
                            reason: 'deadline_penalty_accrual',
                            action: PENALTY_ACCRUAL_ACTION,
                            points_awarded: 0,
                            penalty_applied: deducted,
                            accrued_total: newApplied,
                            hours_overdue: freshHours,
                            timestamp: nowIso,
                            status: 'PROCESSED',
                        });
                        attempt.assignees++;
                        attempt.deducted += deducted;
                    }
                }
                if (changed) {
                    tx.update(doc.ref, { penaltyAccrual: accrual, updatedAt: nowIso });
                }
                return changed;
            });

            if (charged) {
                summary.tasksCharged++;
                summary.assigneesCharged += attempt.assignees;
                summary.totalDeducted += attempt.deducted;
            }
        } catch (err) {
            summary.failed++;
            console.error(`[penalty-accrual] task ${doc.id} failed:`, err);
        }
    }

    return summary;
}
