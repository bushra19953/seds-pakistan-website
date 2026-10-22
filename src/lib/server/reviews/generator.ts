/**
 * reviews/generator.ts - the performance review generator and store
 * (Grove optimization item 9: appraisal; design in
 * ~/workspace/high-output-management/build/item-9-design.md).
 *
 * One Review record per member per term, in the `performance_reviews`
 * collection, doc id `{subjectUid}_{termKey}` (deterministic, so
 * regeneration is idempotent like missRecordId). Every number is
 * computed server-side from collections the member can already see
 * about themselves, so a review can never disagree with the member's
 * own profile:
 *
 *  - tasksApproved / onTimePct: the member's tasks with status
 *    completed inside the window; on time when completedAt is on or
 *    before deadline (the profile-hub telemetry definition).
 *  - pointsEarned: sum of points_awarded over the member's
 *    points_ledger entries inside the window (both award paths write
 *    this shape; the approve path is idempotency-guarded, so no
 *    double award exists).
 *  - missCount: deadline_miss_records for the member with detectedAt
 *    inside the window.
 *  - strikeCount: disciplinary_cases matching the derived warning
 *    counter (E.4.7: status sanction_applied/closed, strikeNumber
 *    set, sanction not revoked by founder review) with decidedAt
 *    inside the window. The counter logic is replicated here rather
 *    than imported so this module stays free of Firestore/Auth
 *    imports and can be unit-tested against a bare fake db.
 *
 * TERM: one fiscal quarter, reusing quarterKeyOf / quarterWindow /
 * parseQuarterKey from the compliance report aggregator (Oct-Sep FY,
 * keys like `FY27-Q1`). The window start/end are stamped onto the
 * review doc at generation, so the doc is self-describing and no
 * settings field or migration is ever needed. Two extra key shapes
 * are recognised for robustness (YYYY-H1/H2 half-years, YYYY-Q1..Q4
 * calendar quarters); an unrecognised key resolves to an unbounded
 * window rather than failing, and the API routes reject such keys
 * before they can reach production data.
 *
 * The only officer-written fields are `messages` (the reviewer's
 * clustered conclusions) and `deliveredAt` / `deliveredBy`.
 * Regenerating a snapshot refreshes the numbers and NEVER overwrites
 * those fields. applyReviewUpdate enforces Grove's order:
 * deliveredAt can only stand while messages is non-empty.
 */
import { isCompletedTask, taskAssigneeIds, toDateSafe } from '@/lib/profile-hub/telemetry';
import {
    parseQuarterKey,
    quarterKeyOf,
    quarterWindow,
} from '@/lib/server/compliance/report-aggregator';

export const PERFORMANCE_REVIEWS_COLLECTION = 'performance_reviews';
export const PERFORMANCE_REVIEW_MESSAGES_MAX = 10000;

export interface ReviewWindow {
    start: Date;
    end: Date;
}

export interface ReviewSnapshot {
    tasksApproved: number;
    onTimePct: number | null;
    /** Alias of onTimePct under the long-form key. Same value. */
    onTimePercentage: number | null;
    pointsEarned: number;
    missCount: number;
    strikeCount: number;
    datedCompletions: number;
    onTimeCount: number;
    lateCount: number;
}

export interface PerformanceReview {
    id: string;
    subjectUid: string;
    termKey: string;
    /** Alias of termKey for readers that use the short field name. */
    term: string;
    windowStart: string;
    windowEnd: string;
    tasksApproved: number;
    onTimePct: number | null;
    onTimePercentage: number | null;
    pointsEarned: number;
    missCount: number;
    strikeCount: number;
    generatedAt: string;
    generatedBy: string | null;
    messages: string | null;
    deliveredAt: string | null;
    deliveredBy: string | null;
    updatedAt: string;
    updatedBy: string | null;
}

export interface ReviewSourceData {
    tasks: any[];
    ledgerEntries: any[];
    missRecords: any[];
    cases: any[];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function num(value: any): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function inWindow(d: Date | null, window: ReviewWindow): boolean {
    return !!d && d.getTime() >= window.start.getTime() && d.getTime() <= window.end.getTime();
}

async function collectWhere(db: any, collection: string, field: string, op: string, value: any): Promise<any[]> {
    const snap = await db.collection(collection).where(field, op, value).get();
    const rows: any[] = [];
    snap.forEach((d: any) => rows.push({ __docId: d.id, ...(d.data() || {}) }));
    return rows;
}

function dedupeByDocId(rows: any[]): any[] {
    const seen = new Map<string, any>();
    for (const row of rows) {
        if (row && typeof row.__docId === 'string' && !seen.has(row.__docId)) seen.set(row.__docId, row);
    }
    return Array.from(seen.values());
}

async function loadReviewSourceData(db: any, subjectUid: string): Promise<ReviewSourceData> {
    const tasks = dedupeByDocId([
        ...(await collectWhere(db, 'tasks', 'assigneeId', '==', subjectUid)),
        ...(await collectWhere(db, 'tasks', 'assigneeIds', 'array-contains', subjectUid)),
    ]);
    const ledgerEntries = dedupeByDocId([
        ...(await collectWhere(db, 'points_ledger', 'user_id', '==', subjectUid)),
        ...(await collectWhere(db, 'points_ledger', 'userId', '==', subjectUid)),
    ]);
    const missRecords = await collectWhere(db, 'deadline_miss_records', 'subjectUid', '==', subjectUid);
    const cases = await collectWhere(db, 'disciplinary_cases', 'subjectUid', '==', subjectUid);
    return { tasks, ledgerEntries, missRecords, cases };
}

interface GenerateArgs {
    subjectUid: string;
    termKey: string;
    actorUid: string | null;
    now: Date;
}

function pickOpts(x: any): any {
    return x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date) &&
        (x.subjectUid || x.uid || x.memberUid || x.term || x.termKey || x.quarterKey)
        ? x
        : null;
}

function normalizeGenerateArgs(a: any, b: any, c: any, d: any): GenerateArgs {
    const opts = pickOpts(a) || pickOpts(b);
    const subjectUid = String(
        opts?.subjectUid || opts?.uid || opts?.memberUid || (typeof a === 'string' ? a : ''),
    );
    const termKey = String(
        opts?.termKey || opts?.term || opts?.quarterKey ||
            (typeof b === 'string' ? b : '') ||
            quarterKeyOf(new Date()),
    );
    const actorUid =
        (typeof opts?.actorUid === 'string' && opts.actorUid) ||
        (typeof opts?.generatedBy === 'string' && opts.generatedBy) ||
        (typeof c === 'string' ? c : null);
    const now =
        d instanceof Date ? d : c instanceof Date ? c : opts?.now instanceof Date ? opts.now : new Date();
    return { subjectUid, termKey, actorUid, now };
}

// ---------------------------------------------------------------------------
// Generator entry points
// ---------------------------------------------------------------------------

/**
 * Compute the snapshot for one member and term from Firestore.
 * Calling conventions: (db, subjectUid, termKey) or (db, options).
 */
export async function generateReviewSnapshot(db: any, a: any, b?: any): Promise<ReviewSnapshot> {
    const { subjectUid, termKey } = normalizeGenerateArgs(a, b, undefined, undefined);
    const window = resolveTermWindow(termKey);
    const data = await loadReviewSourceData(db, subjectUid);
    return assembleReviewSnapshot(subjectUid, data, window);
}

/**
 * Generate (or regenerate) the stored review doc for one member and
 * term. Regeneration refreshes the snapshot numbers and the window
 * stamps only: messages, deliveredAt and deliveredBy from an existing
 * doc are always preserved.
 */
export async function generatePerformanceReview(
    db: any,
    a: any,
    b?: any,
    c?: any,
    d?: any,
): Promise<PerformanceReview> {
    const { subjectUid, termKey, actorUid, now } = normalizeGenerateArgs(a, b, c, d);
    const window = resolveTermWindow(termKey);
    const id = reviewDocId(subjectUid, termKey);
    const ref = db.collection(PERFORMANCE_REVIEWS_COLLECTION).doc(id);
    const existingSnap = await ref.get();
    const existing = existingSnap.exists ? existingSnap.data() || {} : {};

    const data = await loadReviewSourceData(db, subjectUid);
    const snapshot = assembleReviewSnapshot(subjectUid, data, window);
    const nowIso = now.toISOString();

    const review: PerformanceReview = {
        id,
        subjectUid,
        termKey,
        term: termKey,
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        tasksApproved: snapshot.tasksApproved,
        onTimePct: snapshot.onTimePct,
        onTimePercentage: snapshot.onTimePercentage,
        pointsEarned: snapshot.pointsEarned,
        missCount: snapshot.missCount,
        strikeCount: snapshot.strikeCount,
        generatedAt: nowIso,
        generatedBy: actorUid,
        messages: typeof existing.messages === 'string' ? existing.messages : null,
        deliveredAt: typeof existing.deliveredAt === 'string' ? existing.deliveredAt : null,
        deliveredBy: typeof existing.deliveredBy === 'string' ? existing.deliveredBy : null,
        updatedAt: nowIso,
        updatedBy: actorUid,
    };
    await ref.set(review, { merge: true });
    return review;
}

/**
 * Pure snapshot assembler: raw rows in, numbers out. Throws when the
 * source arrays are missing, so a mis-shaped call fails loudly
 * instead of manufacturing a zero review.
 */
export function assembleReviewSnapshot(
    subjectUid: string,
    input: ReviewSourceData,
    window: ReviewWindow,
): ReviewSnapshot {
    if (
        !input ||
        !Array.isArray(input.tasks) ||
        !Array.isArray(input.ledgerEntries) ||
        !Array.isArray(input.missRecords) ||
        !Array.isArray(input.cases)
    ) {
        throw new Error('assembleReviewSnapshot: tasks, ledgerEntries, missRecords and cases arrays are required');
    }

    let tasksApproved = 0;
    let datedCompletions = 0;
    let onTimeCount = 0;
    let lateCount = 0;
    for (const task of input.tasks) {
        if (!task || !taskAssigneeIds(task).includes(subjectUid)) continue;
        if (!isCompletedTask(task)) continue;
        const completedAt = toDateSafe(task.completedAt) || toDateSafe(task.updatedAt);
        if (!inWindow(completedAt, window)) continue;
        tasksApproved++;
        const deadline = toDateSafe(task.deadline);
        if (completedAt && deadline) {
            datedCompletions++;
            if (completedAt.getTime() <= deadline.getTime()) onTimeCount++;
            else lateCount++;
        }
    }

    let pointsEarned = 0;
    for (const entry of input.ledgerEntries) {
        if (!entry) continue;
        const ts = toDateSafe(entry.timestamp) || toDateSafe(entry.createdAt);
        if (!inWindow(ts, window)) continue;
        pointsEarned += num(entry.points_awarded ?? entry.pointsAwarded ?? entry.points);
    }

    let missCount = 0;
    for (const miss of input.missRecords) {
        if (!miss) continue;
        if (inWindow(toDateSafe(miss.detectedAt), window)) missCount++;
    }

    // E.4.7 decided-strike definition (derived-counter.ts), plus the
    // decidedAt window filter.
    let strikeCount = 0;
    for (const c of input.cases) {
        if (!c) continue;
        const decided = c.status === 'sanction_applied' || c.status === 'closed';
        const hasStrike = c.strikeNumber !== null && c.strikeNumber !== undefined;
        const revoked = c.founderReview && c.founderReview.outcome === 'revoke_sanction';
        if (!decided || !hasStrike || revoked) continue;
        const decidedAt = toDateSafe(c.decidedAt) || toDateSafe(c.closedAt);
        if (inWindow(decidedAt, window)) strikeCount++;
    }

    const onTimePct =
        datedCompletions > 0 ? Math.round((onTimeCount / datedCompletions) * 1000) / 10 : null;
    return {
        tasksApproved,
        onTimePct,
        onTimePercentage: onTimePct,
        pointsEarned,
        missCount,
        strikeCount,
        datedCompletions,
        onTimeCount,
        lateCount,
    };
}

// ---------------------------------------------------------------------------
// Store reads and the officer update path
// ---------------------------------------------------------------------------

export async function getPerformanceReview(
    db: any,
    subjectUid: string,
    termKey: string,
): Promise<PerformanceReview | null> {
    const snap = await db
        .collection(PERFORMANCE_REVIEWS_COLLECTION)
        .doc(reviewDocId(subjectUid, termKey))
        .get();
    if (!snap.exists) return null;
    return { id: snap.id, ...(snap.data() || {}) } as PerformanceReview;
}

export async function listPerformanceReviews(db: any, termKey: string): Promise<PerformanceReview[]> {
    const snap = await db
        .collection(PERFORMANCE_REVIEWS_COLLECTION)
        .where('termKey', '==', termKey)
        .get();
    const reviews: PerformanceReview[] = [];
    snap.forEach((d: any) => reviews.push({ id: d.id, ...(d.data() || {}) }));
    reviews.sort((a, b) => String(a.subjectUid).localeCompare(String(b.subjectUid)));
    return reviews;
}

/** The member's own reviews, delivered ones only, newest term first. */
export async function listDeliveredReviewsForMember(db: any, uid: string): Promise<PerformanceReview[]> {
    const snap = await db
        .collection(PERFORMANCE_REVIEWS_COLLECTION)
        .where('subjectUid', '==', uid)
        .get();
    const reviews: PerformanceReview[] = [];
    snap.forEach((d: any) => {
        const data = d.data() || {};
        if (typeof data.deliveredAt === 'string' && data.deliveredAt) {
            reviews.push({ id: d.id, ...data });
        }
    });
    reviews.sort((a, b) => String(b.termKey).localeCompare(String(a.termKey)));
    return reviews;
}

export type ReviewUpdateResult =
    | { ok: true; review: PerformanceReview }
    | { ok: false; status: number; message: string };

/**
 * The only officer edit path: messages and deliveredAt/deliveredBy.
 * Enforces the ordering rule: a review may stand as delivered only
 * while its messages are non-empty (conclusions before delivery).
 */
export async function applyReviewUpdate(
    db: any,
    input: {
        subjectUid: string;
        termKey: string;
        messages?: string;
        delivered?: boolean;
        deliveredAt?: string | null;
        actorUid: string;
    },
    now: Date = new Date(),
): Promise<ReviewUpdateResult> {
    if (input.messages !== undefined) {
        if (typeof input.messages !== 'string') {
            return { ok: false, status: 400, message: 'messages must be a string' };
        }
        if (input.messages.length > PERFORMANCE_REVIEW_MESSAGES_MAX) {
            return {
                ok: false,
                status: 400,
                message: `messages must be at most ${PERFORMANCE_REVIEW_MESSAGES_MAX} characters`,
            };
        }
    }

    const existing = await getPerformanceReview(db, input.subjectUid, input.termKey);
    if (!existing) {
        return {
            ok: false,
            status: 404,
            message: 'No review for that member and term. Generate the snapshot first.',
        };
    }

    const nextMessages = input.messages !== undefined ? input.messages : existing.messages || '';
    const wantsDeliver =
        input.delivered === true || (typeof input.deliveredAt === 'string' && input.deliveredAt.length > 0);
    const wantsUndeliver = input.delivered === false || input.deliveredAt === null;
    const nextDelivered = wantsUndeliver ? false : wantsDeliver ? true : !!existing.deliveredAt;

    if (nextDelivered && nextMessages.trim().length === 0) {
        return {
            ok: false,
            status: 400,
            message:
                'Messages must be non-empty before a review can be marked delivered: conclusions first, then the conversation.',
        };
    }

    const nowIso = now.toISOString();
    const patch: Record<string, any> = { updatedAt: nowIso, updatedBy: input.actorUid };
    if (input.messages !== undefined) patch.messages = input.messages;
    if (wantsDeliver && !existing.deliveredAt) {
        const provided = typeof input.deliveredAt === 'string' ? new Date(input.deliveredAt) : null;
        patch.deliveredAt = provided && !Number.isNaN(provided.getTime()) ? provided.toISOString() : nowIso;
        patch.deliveredBy = input.actorUid;
    } else if (wantsUndeliver && existing.deliveredAt) {
        patch.deliveredAt = null;
        patch.deliveredBy = null;
    }

    await db.collection(PERFORMANCE_REVIEWS_COLLECTION).doc(existing.id).set(patch, { merge: true });
    const review = await getPerformanceReview(db, input.subjectUid, input.termKey);
    return { ok: true, review: review as PerformanceReview };
}

// ---------------------------------------------------------------------------
// Term keys and windows
// ---------------------------------------------------------------------------

export function reviewDocId(subjectUid: string, termKey: string): string {
    return `${subjectUid}_${termKey}`;
}

/** True for term keys resolveTermWindow can bound (FY quarters, half-years, calendar quarters). */
export function isValidReviewTermKey(value: unknown): value is string {
    if (typeof value !== 'string' || !value) return false;
    if (parseQuarterKey(value)) return true;
    return /^\d{4}-H[12]$/.test(value) || /^\d{4}-Q[1-4]$/.test(value);
}

export function resolveTermWindow(termKey: string | null | undefined): ReviewWindow {
    if (termKey) {
        const qw = quarterWindow(termKey);
        if (qw) return { start: qw.start, end: qw.end };
        const half = /^(\d{4})-H([12])$/.exec(termKey);
        if (half) {
            const year = Number(half[1]);
            const start = new Date(Date.UTC(year, half[2] === '1' ? 0 : 6, 1));
            const end = new Date(start.getTime());
            end.setUTCMonth(start.getUTCMonth() + 6);
            return { start, end: new Date(end.getTime() - 1) };
        }
        const cq = /^(\d{4})-Q([1-4])$/.exec(termKey);
        if (cq) {
            const year = Number(cq[1]);
            const start = new Date(Date.UTC(year, (Number(cq[2]) - 1) * 3, 1));
            const end = new Date(start.getTime());
            end.setUTCMonth(start.getUTCMonth() + 3);
            return { start, end: new Date(end.getTime() - 1) };
        }
    }
    // Unrecognised key: unbounded. The routes reject such keys; this
    // fallback exists so a direct caller still gets a well-defined,
    // all-time snapshot instead of a crash or a silently wrong window.
    return { start: new Date(0), end: new Date(8640000000000000) };
}
