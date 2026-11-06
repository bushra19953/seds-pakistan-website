/**
 * workflow-bottleneck.ts - the AT_RISK_DEPENDENCY bottleneck flag
 * (Founder-approved design, 2026-11-06; second-brain Orders 47/48
 * Item A).
 *
 * When a workflow step is overdue and the NEXT step in the same
 * workflow has not been released, the overdue step is the bottleneck:
 * the workflow cannot advance past it. This pass stamps the blocking
 * step's task doc with
 *
 *   dependencyFlag: 'AT_RISK_DEPENDENCY',
 *   dependencyFlaggedAt: <iso>,
 *   dependencyBlockedTaskId: <the waiting step's task id>
 *
 * which the admin Missions tab renders as a badge on the step. The
 * flag clears automatically once the step stops blocking (it is
 * submitted or completed, or the downstream step is released or
 * completed).
 *
 * The flag is information for humans, never a sanction: this pass
 * writes ONLY the three flag fields (plus updatedAt) on task docs.
 * It creates no warnings, no miss records, no point movements, and no
 * notifications. Warnings remain issuable only as the recorded
 * outcome of a decided disciplinary case (applyCaseDecision).
 *
 * Hosted as a named step of the daily /api/cron/overdue run, after
 * the overdue marking pass, so steps marked overdue in the same run
 * are evaluated with their fresh status.
 */

export const BOTTLENECK_FLAG = 'AT_RISK_DEPENDENCY';

const TERMINAL_STATUSES = ['completed', 'approved'];

export interface BottleneckSummary {
    scanned: number;
    flagged: number;
    cleared: number;
    stillFlagged: number;
}

function isBlockedBy(downstream: any): boolean {
    if (!downstream) return false;
    const status = String(downstream.status || '').toLowerCase();
    if (TERMINAL_STATUSES.includes(status)) return false;
    // A released downstream step is not waiting on the blocker: the
    // workflow already advanced past it (release-on-overdue).
    if (downstream.isCurrentStep === true) return false;
    if (downstream.releasedAt != null) return false;
    return true;
}

async function findDownstream(db: any, task: any): Promise<any | null> {
    const wfId = String(task?.workflowId || '');
    const seq = Number(task?.sequenceIndex);
    if (!wfId || !Number.isFinite(seq)) return null;
    const snap = await db
        .collection('tasks')
        .where('workflowId', '==', wfId)
        .where('sequenceIndex', '==', seq + 1)
        .limit(1)
        .get();
    if (snap.empty || !snap.docs.length) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ref: doc.ref, ...(doc.data() || {}) };
}

/**
 * One flag pass. Evaluates every overdue workflow step, then sweeps
 * every currently flagged doc and clears the ones that no longer
 * block anything. Takes the caller's Firestore handle (the discipline
 * services pattern) so it is testable against a fake db.
 */
export async function runBottleneckFlagPass(db: any, now: Date): Promise<BottleneckSummary> {
    const summary: BottleneckSummary = { scanned: 0, flagged: 0, cleared: 0, stillFlagged: 0 };
    const nowIso = now.toISOString();
    const stillBlocking = new Set<string>();

    const overdueSnap = await db.collection('tasks').where('status', '==', 'overdue').get();
    summary.scanned = overdueSnap.size ?? overdueSnap.docs.length;

    for (const doc of overdueSnap.docs) {
        const task = doc.data() || {};
        if (!String(task.workflowId || '')) continue;
        if (!Number.isFinite(Number(task.sequenceIndex))) continue;
        const downstream = await findDownstream(db, task);
        if (!isBlockedBy(downstream)) continue;
        stillBlocking.add(doc.id);
        if (task.dependencyFlag === BOTTLENECK_FLAG && task.dependencyBlockedTaskId === downstream.id) {
            summary.stillFlagged++;
            continue;
        }
        await doc.ref.update({
            dependencyFlag: BOTTLENECK_FLAG,
            dependencyFlaggedAt: nowIso,
            dependencyBlockedTaskId: downstream.id,
            updatedAt: nowIso,
        });
        summary.flagged++;
    }

    // Clear pass: any flagged doc that is not still blocking loses the
    // flag (its step was submitted, completed, or unblocked).
    const flaggedSnap = await db
        .collection('tasks')
        .where('dependencyFlag', '==', BOTTLENECK_FLAG)
        .get();
    for (const doc of flaggedSnap.docs) {
        if (stillBlocking.has(doc.id)) continue;
        await doc.ref.update({
            dependencyFlag: null,
            dependencyFlaggedAt: null,
            dependencyBlockedTaskId: null,
            updatedAt: nowIso,
        });
        summary.cleared++;
    }

    return summary;
}
