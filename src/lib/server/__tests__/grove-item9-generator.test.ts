/**
 * @jest-environment node
 *
 * Grove Item 9 - performance review GENERATOR tests.
 *
 * Spec: ~/workspace/your_files/seds_website_grove_optimization_comparison.md,
 * Item 9. One Review record per member per term, generated server-side
 * from data already stored: tasks approved, on-time percentage, points
 * earned (points_ledger), deadline misses, strikes. Plus two officer
 * fields: `messages` (the reviewer's clustered conclusions) and
 * `deliveredAt`, settable only when messages is non-empty (that rule is
 * exercised in the route tests, grove-item9-route.test.ts).
 *
 * STATUS AT AUTHORING TIME: the Item 9 implementation had NOT landed in
 * this worktree yet (tree clean at the base commit; no file under src
 * referenced deliveredAt). These tests therefore DISCOVER the generator
 * module at run time instead of pinning one guessed path: any non-route,
 * non-test module under src that mentions deliveredAt / a performance
 * review and exports a review-building function is a candidate. While no
 * candidate exists, the suite fails with an explicit "not landed"
 * message - that red is the honest signal, not a broken test.
 *
 * The fixtures are internally consistent across every plausible source
 * collection, so the expected math holds whichever source the generator
 * reads:
 *   tasks (assigneeId=member, status=completed): 4, of which 3 on time
 *     and 1 late  ->  tasksApproved 4, on-time 75%
 *   points_ledger (user_id=member): 10 + 20 + 5  ->  pointsEarned 35
 *     (task pointsAwarded sums to the same 35)
 *   deadline_miss_records (subjectUid=member): 2  ->  missCount 2
 *   disciplinary_cases: 1 decided case with strikeNumber 1 (plus 1
 *     dismissed case with no strike)  ->  strikeCount 1
 *   users/{member}.total_points is also 35.
 */
import * as fs from 'fs';
import * as path from 'path';
import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';

const MEMBER = 'member-a';
const OTHER = 'member-b';
const TERM = '2026-T1';

function seedFixtures(db: any) {
    db.seed('roleDefinitions/member', { permissions: [] });
    db.seed(`users/${MEMBER}`, { role: 'member', total_points: 35, points: 35 });
    db.seed(`users/${OTHER}`, { role: 'member', total_points: 99, points: 99 });

    const task = (id: string, over: Record<string, any>) =>
        db.seed(`tasks/${id}`, {
            assigneeId: MEMBER,
            assignees: [MEMBER],
            status: 'completed',
            ...over,
        });
    // 3 on time
    task('t1', { deadline: '2026-10-10T00:00:00.000Z', completedAt: '2026-10-09T12:00:00.000Z', pointsAwarded: 10, points: 10 });
    task('t2', { deadline: '2026-10-11T00:00:00.000Z', completedAt: '2026-10-10T12:00:00.000Z', pointsAwarded: 20, points: 20 });
    task('t3', { deadline: '2026-10-12T00:00:00.000Z', completedAt: '2026-10-11T12:00:00.000Z', pointsAwarded: 5, points: 5 });
    // 1 late
    task('t4', { deadline: '2026-10-10T00:00:00.000Z', completedAt: '2026-10-12T12:00:00.000Z', pointsAwarded: 0, points: 0 });
    // Not completed -> excluded from approved count
    task('t5', { status: 'pending', deadline: '2026-10-10T00:00:00.000Z', completedAt: null, pointsAwarded: 0, points: 0 });
    // Someone else's completed task -> excluded
    db.seed('tasks/t6', {
        assigneeId: OTHER,
        assignees: [OTHER],
        status: 'completed',
        deadline: '2026-10-10T00:00:00.000Z',
        completedAt: '2026-10-09T12:00:00.000Z',
        pointsAwarded: 99,
        points: 99,
    });

    const ledger = (id: string, user_id: string, points_awarded: number) =>
        db.seed(`points_ledger/${id}`, { user_id, points_awarded, status: 'PROCESSED', timestamp: '2026-10-10T00:00:00.000Z' });
    ledger('l1', MEMBER, 10);
    ledger('l2', MEMBER, 20);
    ledger('l3', MEMBER, 5);
    ledger('l4', OTHER, 99);

    const miss = (id: string, subjectUid: string) =>
        db.seed(`deadline_miss_records/${id}`, {
            missId: id,
            taskId: `task-${id}`,
            subjectUid,
            status: 'recorded',
            detectedAt: '2026-10-10T00:00:00.000Z',
        });
    miss('m1', MEMBER);
    miss('m2', MEMBER);
    miss('m3', OTHER);

    db.seed('disciplinary_cases/c1', {
        subjectUid: MEMBER,
        strikeNumber: 1,
        status: 'sanction_applied',
        decision: 'formal warning (Strike 1)',
        decidedAt: '2026-10-10T00:00:00.000Z',
    });
    db.seed('disciplinary_cases/c2', {
        subjectUid: MEMBER,
        strikeNumber: null,
        status: 'closed',
        decision: 'dismissed',
        decidedAt: '2026-10-10T00:00:00.000Z',
    });
    return db;
}

/** Walk src for candidate generator modules (see header). */
function findGeneratorCandidates(): string[] {
    const srcRoot = path.join(process.cwd(), 'src');
    const hits: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'route.ts') {
                const src = fs.readFileSync(full, 'utf8');
                if (src.includes('deliveredAt') || (/performance.?review/i.test(src) && /on.?time/i.test(src))) {
                    hits.push(full);
                }
            }
        }
    };
    walk(srcRoot);
    // Prefer paths that look like a review module.
    return hits.sort((a, b) => Number(/review/i.test(b)) - Number(/review/i.test(a)));
}

function pickNumber(obj: any, keys: string[]): number | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (v && typeof v === 'object') {
            const nested = pickNumber(v, keys);
            if (nested !== undefined) return nested;
        }
    }
    return undefined;
}

/** Find a snapshot the generator persisted into the fake db, if any. */
function findPersistedSnapshot(db: any): any | null {
    for (const [, col] of db.store.entries()) {
        for (const [, data] of (col as Map<string, any>).entries()) {
            const owner = data.subjectUid || data.memberUid || data.user_id || data.uid || data.memberId;
            const looksLikeReview =
                'deliveredAt' in data || 'messages' in data || 'onTimePercentage' in data || 'onTimePercent' in data;
            if (owner === MEMBER && looksLikeReview) return data;
        }
    }
    return null;
}

/**
 * Call the discovered generator under the calling conventions used by
 * this codebase's server services (db first, then subject, then term -
 * as an argument, an options object, or a single options object).
 * Returns the snapshot object, whether returned or persisted.
 */
async function runGenerator(fn: (...args: any[]) => any): Promise<any | null> {
    const conventions: Array<() => Promise<any>> = [
        async () => fn(seedDb(), MEMBER, TERM),
        async () => fn(seedDb(), MEMBER, { term: TERM }),
        async () => fn(seedDb(), { subjectUid: MEMBER, term: TERM }),
        async () => fn(seedDb(), { memberUid: MEMBER, term: TERM }),
        async () => fn({ db: seedDb(), subjectUid: MEMBER, term: TERM }),
        async () => fn(seedDb(), MEMBER, TERM, new Date('2026-10-15T00:00:00.000Z')),
    ];
    // Each attempt needs its OWN seeded db; keep them paired.
    const dbs: any[] = [];
    const seedDb = () => {
        const db = seedFixtures(makeFakeDb());
        dbs.push(db);
        return db;
    };
    for (let i = 0; i < conventions.length; i++) {
        const before = dbs.length;
        try {
            const result = await conventions[i]();
            const db = dbs[before];
            if (result && typeof result === 'object') {
                const snap = result.snapshot || result.review || result;
                if (pickNumber(snap, ['tasksApproved', 'tasksCompleted', 'approvedTasks']) !== undefined) return snap;
            }
            const persisted = db ? findPersistedSnapshot(db) : null;
            if (persisted) return persisted;
            if (result && typeof result === 'object') return result.snapshot || result.review || result;
        } catch {
            // Try the next convention.
        }
    }
    return null;
}

describe('Grove Item 9 - performance review generator', () => {
    const candidates = findGeneratorCandidates();
    let snapshot: any = null;
    let generatorError: string | null = null;

    beforeAll(async () => {
        for (const file of candidates) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const mod = require(file);
                const fns = Object.values(mod).filter(
                    (v: any) => typeof v === 'function' && /review|snapshot/i.test(String((v as any).name || '')),
                ) as Array<(...args: any[]) => any>;
                const anyFns = fns.length ? fns : (Object.values(mod).filter((v: any) => typeof v === 'function') as any[]);
                for (const fn of anyFns) {
                    snapshot = await runGenerator(fn);
                    if (snapshot) return;
                }
            } catch (err: any) {
                generatorError = err?.message || String(err);
            }
        }
    });

    it('implementation has landed: a review generator module exists under src', () => {
        expect(
            candidates.length > 0
                ? true
                : `NOT LANDED: no module under src mentions deliveredAt or a performance review. ` +
                      `Implement Item 9 (generator + route) and re-run. Last error: ${generatorError}`,
        ).toBe(true);
    });

    it('generator runs against fixture members and returns a snapshot', () => {
        expect(snapshot).not.toBeNull();
    });

    it('counts approved/completed tasks for the member only', () => {
        const n = pickNumber(snapshot, ['tasksApproved', 'tasksCompleted', 'approvedTasks', 'completedTasks', 'tasksApprovedCount']);
        expect(n).toBe(4);
    });

    it('computes on-time percentage as 3 of 4 = 75%', () => {
        const raw = pickNumber(snapshot, ['onTimePercentage', 'onTimePercent', 'on_time_percentage', 'onTimeRate']);
        expect(raw).toBeDefined();
        const pct = (raw as number) <= 1 ? (raw as number) * 100 : (raw as number);
        expect(pct).toBeCloseTo(75, 1);
    });

    it('sums points earned to 35', () => {
        const n = pickNumber(snapshot, ['pointsEarned', 'totalPoints', 'points', 'pointsAwarded', 'points_total']);
        expect(n).toBe(35);
    });

    it('counts deadline misses for the member only', () => {
        const n = pickNumber(snapshot, ['missCount', 'misses', 'deadlineMisses', 'deadlineMissCount', 'miss_count']);
        expect(n).toBe(2);
    });

    it('counts strikes, ignoring the dismissed case', () => {
        const n = pickNumber(snapshot, ['strikeCount', 'strikes', 'activeStrikes', 'strike_count']);
        expect(n).toBe(1);
    });
});
