/**
 * task-approval-rate.ts — Grove Item 13: last-10 approval rate at the
 * review point.
 *
 * Computes, at read time and with no stored field, how many of a
 * member's most recent DECIDED task submissions were approved. The
 * figure exists to make the performer's record visible where a
 * reviewer is about to decide. It is submission history, not a verdict
 * on the person, and it changes nothing by itself: no auto-approval,
 * no stored value, no write path anywhere in this module.
 *
 * Two decision vocabularies collide on task docs and both are
 * coalesced, or the rate badly undercounts (most real approvals land
 * as 'completed'):
 *   - /api/tasks stamps approvedBy/approvedAt on approval and
 *     rejectedBy/rejectedAt on changes-requested.
 *   - PATCH /api/admin/universal-review stamps reviewedBy/reviewedAt
 *     for both outcomes and status 'approved'/'rejected'.
 *
 * Decided (denominator): completed | approved | rejected |
 * changes-requested. Approved (numerator): completed | approved.
 * Excluded: pending, in-progress, submitted-for-review, overdue (a
 * calculated display status the tasks route never persists), and
 * cancelled (no task writer ever sets it).
 *
 * This module has no runtime imports on purpose: it stays pure over an
 * injected db handle (the recordMiss pattern in
 * src/lib/server/discipline/miss-records.ts), so it is unit-testable
 * with a fake Firestore, and client components may import the label
 * formatter without pulling in the Admin SDK.
 */

export const APPROVAL_RATE_WINDOW = 10;

export const DECIDED_TASK_STATUSES: ReadonlySet<string> = new Set([
    'completed',
    'approved',
    'rejected',
    'changes-requested',
]);

export const APPROVED_TASK_STATUSES: ReadonlySet<string> = new Set([
    'completed',
    'approved',
]);

export interface ApprovalRate {
    approved: number;
    decided: number;
    /** approved / decided, or null when there is no decided history. */
    rate: number | null;
    hasHistory: boolean;
}

function noHistory(): ApprovalRate {
    return { approved: 0, decided: 0, rate: null, hasHistory: false };
}

/**
 * Resolve the submitter a task's decision counts for, mirroring the
 * review-queue route: submittedBy (server-stamped on every transition
 * into submitted-for-review) wins, then the primary assignee, then the
 * first co-assignee.
 */
export function resolveTaskSubmitterUid(data: Record<string, any>): string | null {
    const candidates: any[] = [
        data?.submittedBy,
        data?.assigneeId,
        Array.isArray(data?.assigneeIds) ? data.assigneeIds[0] : undefined,
        Array.isArray(data?.assigneeId) ? data.assigneeId[0] : undefined,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    }
    return null;
}

function toMillis(value: any): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) {
        const t = value.getTime();
        return Number.isNaN(t) ? null : t;
    }
    if (typeof value === 'string') {
        const t = Date.parse(value);
        return Number.isNaN(t) ? null : t;
    }
    if (typeof value?.toDate === 'function') {
        try {
            const d = value.toDate();
            const t = d?.getTime?.();
            return typeof t === 'number' && !Number.isNaN(t) ? t : null;
        } catch {
            return null;
        }
    }
    if (typeof value?.seconds === 'number') {
        return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
    }
    return null;
}

/**
 * Decision timestamp, coalesced across both writer vocabularies in
 * this order: approvedAt ?? rejectedAt ?? reviewedAt ?? completedAt ??
 * updatedAt (decidedAt/createdAt are last-resort fallbacks for legacy
 * docs that carry nothing else).
 */
export function coalesceDecisionMillis(data: Record<string, any>): number | null {
    const chain = [
        data?.approvedAt,
        data?.rejectedAt,
        data?.reviewedAt,
        data?.completedAt,
        data?.updatedAt,
        data?.decidedAt,
        data?.createdAt,
    ];
    for (const value of chain) {
        const millis = toMillis(value);
        if (millis !== null) return millis;
    }
    return null;
}

function statusOf(row: Record<string, any>): string {
    const raw = row?.status ?? row?.reviewStatus ?? row?.decision ?? '';
    return String(raw).toLowerCase().trim();
}

/**
 * Pure computation over an array of submission/task-shaped objects.
 * Input order is treated as most-recent first for timestamp ties; the
 * window is the 10 most recent DECIDED entries.
 */
export function computeApprovalRate(input: any): ApprovalRate {
    const list: any[] = Array.isArray(input)
        ? input
        : Array.isArray(input?.submissions)
            ? input.submissions
            : Array.isArray(input?.tasks)
                ? input.tasks
                : [];

    const decidedRows: Array<{ approved: boolean; at: number; idx: number }> = [];
    list.forEach((row: any, idx: number) => {
        if (!row || typeof row !== 'object') return;
        const status = statusOf(row);
        if (!DECIDED_TASK_STATUSES.has(status)) return;
        decidedRows.push({
            approved: APPROVED_TASK_STATUSES.has(status),
            at: coalesceDecisionMillis(row) ?? 0,
            idx,
        });
    });

    // Most recent first; ties keep input order (already most-recent
    // first by the read-path convention).
    decidedRows.sort((a, b) => (b.at - a.at) || (a.idx - b.idx));

    const windowRows = decidedRows.slice(0, APPROVAL_RATE_WINDOW);
    const decided = windowRows.length;
    const approved = windowRows.filter((r) => r.approved).length;
    return {
        approved,
        decided,
        rate: decided > 0 ? approved / decided : null,
        hasHistory: decided > 0,
    };
}

/** Minimal structural shape of the Firestore handle this module needs. */
export interface ApprovalRateQuery {
    where(field: string, op: string, value: any): ApprovalRateQuery;
    get(): Promise<{ docs: Array<{ id: string; data: () => Record<string, any> }> }>;
}

export interface ApprovalRateDb {
    collection(name: string): ApprovalRateQuery;
}

/**
 * The server helper (Item 13, "Optimization: how" step 1). Three
 * single-field query legs (assigneeId ==, assigneeIds array-contains,
 * submittedBy ==), deduped by doc id, attributed by the resolved
 * submitter, then filtered, sorted, and windowed in memory. No
 * composite index is needed and nothing is written.
 *
 * Caveat carried from the design note: the rate is a snapshot of each
 * task's LATEST state. A changes-requested that was later resubmitted
 * and approved counts once, at its final outcome, because the tasks
 * route clears the earlier decision stamps on resubmission.
 */
export async function getLast10ApprovalRate(db: ApprovalRateDb, uid: string): Promise<ApprovalRate> {
    if (!db || typeof (db as any).collection !== 'function' || typeof uid !== 'string' || uid.trim() === '') {
        return noHistory();
    }

    const legs: Array<[string, string, any]> = [
        ['assigneeId', '==', uid],
        ['assigneeIds', 'array-contains', uid],
        ['submittedBy', '==', uid],
    ];

    const byId = new Map<string, Record<string, any>>();
    let failedLegs = 0;
    for (const [field, op, value] of legs) {
        try {
            // Deliberately UNBOUNDED (pinned by C-AR-01/03): the
            // 10-task window is applied in memory AFTER the
            // submitter-attribution filter, so a query limit could
            // silently drop decided tasks and change the rate for
            // heavy accounts — a successful-response behavior change.
            // Census 04 T10's bound was tried in train 2 and reverted
            // for exactly that reason; what T10 keeps is the loud
            // all-legs-failed log below. A safe bound needs an
            // orderBy(decidedAt desc) + attribution redesign, which
            // is a separate behavior-bearing change.
            const snap = await db.collection('tasks').where(field, op, value).get();
            for (const docSnap of snap.docs || []) {
                if (docSnap && typeof docSnap.data === 'function' && !byId.has(docSnap.id)) {
                    byId.set(docSnap.id, docSnap.data() || {});
                }
            }
        } catch {
            // One failing leg must not sink the others; the figure is
            // advisory and degrades to whatever the other legs found.
            failedLegs++;
        }
    }
    if (failedLegs === legs.length) {
        // Census 04 T10: when EVERY leg fails, the resulting
        // "No decided submissions yet" is fake — log it loudly so it
        // is distinguishable from a genuine no-history answer.
        console.error(`[task-approval-rate] All ${legs.length} Firestore legs failed for uid ${uid}; the no-history figure below is degraded, not real`);
    }

    const mine: Array<Record<string, any>> = [];
    for (const data of byId.values()) {
        if (resolveTaskSubmitterUid(data) === uid) mine.push(data);
    }
    return computeApprovalRate(mine);
}

/**
 * The rendered figure, with its real denominator: "9 of last 10
 * approved (90%)", or "3 of last 4 approved (75%)" when fewer than 10
 * decided submissions exist. Zero history gets an honest label, never
 * an invented percentage.
 */
export function formatApprovalRateLabel(rate: ApprovalRate | null | undefined): string {
    if (!rate || typeof rate.decided !== 'number' || rate.decided <= 0) {
        return 'No decided submissions yet';
    }
    const pct = Math.round((rate.approved / rate.decided) * 100);
    return `${rate.approved} of last ${rate.decided} approved (${pct}%)`;
}
