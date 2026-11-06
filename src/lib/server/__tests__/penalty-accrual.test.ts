/**
 * @jest-environment node
 *
 * Geometric hourly penalty accrual (Founder-approved design,
 * 2026-11-06): doubling hourly deductions (2, 4, 8, ...) capped at
 * the task's penaltyPoints; submission and proof freeze the clock;
 * approved leave exempts; the pass is idempotent and balance-limited.
 */
jest.mock('@/lib/server/leave-exemption', () => ({
    isExemptFromDeadlinePenalty: jest.fn(async () => ({ exempt: false, reason: null, leaveRequestId: null })),
}));

import { makeFakeDb } from '../discipline/__tests__/fake-firestore';
import { accruedPenaltyForHours, runPenaltyAccrual, wholeHoursOverdue } from '../penalty-accrual';
import { isExemptFromDeadlinePenalty } from '../leave-exemption';

const HOUR = 60 * 60 * 1000;
const DEADLINE = Date.parse('2026-11-01T00:00:00.000Z');
const mockLeave = isExemptFromDeadlinePenalty as jest.Mock;

beforeEach(() => {
    mockLeave.mockReset();
    mockLeave.mockResolvedValue({ exempt: false, reason: null, leaveRequestId: null });
});

describe('doubling schedule and cap', () => {
    test('cumulative schedule is 2, 6, 14, 30, 62 before the cap', () => {
        expect(accruedPenaltyForHours(0, 100)).toBe(0);
        expect(accruedPenaltyForHours(1, 100)).toBe(2);
        expect(accruedPenaltyForHours(2, 100)).toBe(6);
        expect(accruedPenaltyForHours(3, 100)).toBe(14);
        expect(accruedPenaltyForHours(4, 100)).toBe(30);
        expect(accruedPenaltyForHours(5, 100)).toBe(62);
        expect(accruedPenaltyForHours(6, 100)).toBe(100);
    });

    test('a typical 30-point cap is fully consumed at hour 4', () => {
        expect(accruedPenaltyForHours(3, 30)).toBe(14);
        expect(accruedPenaltyForHours(4, 30)).toBe(30);
        expect(accruedPenaltyForHours(5, 30)).toBe(30);
    });

    test('huge hour counts stay capped and exact (no overflow drift)', () => {
        expect(accruedPenaltyForHours(100000, 30)).toBe(30);
        expect(accruedPenaltyForHours(100000, 1000000)).toBe(1000000);
    });

    test('degenerate inputs accrue nothing', () => {
        expect(accruedPenaltyForHours(5, 0)).toBe(0);
        expect(accruedPenaltyForHours(5, -10)).toBe(0);
        expect(accruedPenaltyForHours(Number.NaN, 30)).toBe(0);
        expect(accruedPenaltyForHours(5, Number.NaN)).toBe(0);
    });

    test('whole hours only: 59 minutes overdue accrues nothing', () => {
        expect(wholeHoursOverdue(DEADLINE, DEADLINE + 59 * 60 * 1000)).toBe(0);
        expect(wholeHoursOverdue(DEADLINE, DEADLINE + HOUR)).toBe(1);
        expect(wholeHoursOverdue(DEADLINE, DEADLINE - HOUR)).toBe(0);
    });
});

function seedTask(db: any, id: string, overrides: Record<string, any> = {}) {
    db.seed(`tasks/${id}`, {
        title: `Task ${id}`,
        status: 'pending',
        assigneeIds: ['user-1'],
        assigneeId: 'user-1',
        points: 50,
        penaltyPoints: 30,
        deadline: new Date(DEADLINE).toISOString(),
        ...overrides,
    });
}

describe('runPenaltyAccrual', () => {
    test('deducts the schedule delta from the balance and records it on the task and ledger', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U', total_points: 100, points: 100 });
        seedTask(db, 't1');
        const now = new Date(DEADLINE + 3 * HOUR); // target: 14 of 30

        const summary = await runPenaltyAccrual(db, now);
        expect(summary.tasksCharged).toBe(1);
        expect(summary.assigneesCharged).toBe(1);
        expect(summary.totalDeducted).toBe(14);
        expect(db.read('users/user-1')?.total_points).toBe(86);
        expect(db.read('users/user-1')?.points).toBe(86);
        const accrual = db.read('tasks/t1')?.penaltyAccrual?.['user-1'];
        expect(accrual.applied).toBe(14);
        expect(accrual.targetAccrued).toBe(14);
        const ledger = db.readCollection('points_ledger');
        expect(ledger).toHaveLength(1);
        expect(ledger[0].id).toBe('accrual_t1_user-1_14');
        expect(ledger[0].data.action).toBe('PENALTY_ACCRUAL');
        expect(ledger[0].data.penalty_applied).toBe(14);
    });

    test('a rerun at the same instant is a no-op; a later run deducts only the new delta up to the cap', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U', total_points: 100, points: 100 });
        seedTask(db, 't1');

        await runPenaltyAccrual(db, new Date(DEADLINE + 3 * HOUR));
        const again = await runPenaltyAccrual(db, new Date(DEADLINE + 3 * HOUR));
        expect(again.totalDeducted).toBe(0);
        expect(db.read('users/user-1')?.total_points).toBe(86);

        const later = await runPenaltyAccrual(db, new Date(DEADLINE + 10 * HOUR));
        expect(later.totalDeducted).toBe(16); // 14 -> 30 (cap)
        expect(db.read('users/user-1')?.total_points).toBe(70);
        expect(db.read('tasks/t1')?.penaltyAccrual?.['user-1'].applied).toBe(30);
        expect(db.readCollection('points_ledger')).toHaveLength(2);
    });

    test('submission freezes the clock: submitted-for-review tasks are never scanned', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U', total_points: 100, points: 100 });
        seedTask(db, 't1', { status: 'submitted-for-review', submittedAt: new Date(DEADLINE + HOUR).toISOString() });
        const summary = await runPenaltyAccrual(db, new Date(DEADLINE + 10 * HOUR));
        expect(summary.scanned).toBe(0);
        expect(db.read('users/user-1')?.total_points).toBe(100);
        expect(db.read('tasks/t1')?.penaltyAccrual).toBeUndefined();
    });

    test('proof uploaded freezes accrual even while the status still reads overdue', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U', total_points: 100, points: 100 });
        seedTask(db, 't1', { status: 'overdue', deliverableFiles: [{ name: 'proof.pdf' }] });
        const summary = await runPenaltyAccrual(db, new Date(DEADLINE + 10 * HOUR));
        expect(summary.skippedProof).toBe(1);
        expect(summary.totalDeducted).toBe(0);
        expect(db.read('users/user-1')?.total_points).toBe(100);
    });

    test('approved leave exempts the assignee entirely', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U', total_points: 100, points: 100 });
        seedTask(db, 't1');
        mockLeave.mockResolvedValue({ exempt: true, reason: 'approved leave', leaveRequestId: 'lr-1' });
        const summary = await runPenaltyAccrual(db, new Date(DEADLINE + 10 * HOUR));
        expect(summary.skippedLeaveExempt).toBe(1);
        expect(summary.totalDeducted).toBe(0);
        expect(db.read('users/user-1')?.total_points).toBe(100);
        expect(db.read('tasks/t1')?.penaltyAccrual).toBeUndefined();
    });

    test('deduction is limited by the balance; the remainder stays owed on the accrual record', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U', total_points: 5, points: 5 });
        seedTask(db, 't1');
        const summary = await runPenaltyAccrual(db, new Date(DEADLINE + 3 * HOUR)); // target 14, balance 5
        expect(summary.totalDeducted).toBe(5);
        expect(db.read('users/user-1')?.total_points).toBe(0);
        const accrual = db.read('tasks/t1')?.penaltyAccrual?.['user-1'];
        expect(accrual.applied).toBe(5);
        expect(accrual.targetAccrued).toBe(14);
    });

    test('each assignee accrues independently; tasks without a penalty or a future deadline are skipped', async () => {
        const db = makeFakeDb();
        db.seed('users/user-1', { displayName: 'U1', total_points: 100, points: 100 });
        db.seed('users/user-2', { displayName: 'U2', total_points: 100, points: 100 });
        seedTask(db, 't1', { assigneeIds: ['user-1', 'user-2'] });
        seedTask(db, 't2', { penaltyPoints: 0 });
        seedTask(db, 't3', { deadline: new Date(DEADLINE + 30 * HOUR).toISOString() });
        const summary = await runPenaltyAccrual(db, new Date(DEADLINE + 2 * HOUR));
        expect(summary.skippedNoPenalty).toBe(1);
        expect(summary.skippedNotDue).toBe(1);
        expect(summary.assigneesCharged).toBe(2);
        expect(db.read('users/user-1')?.total_points).toBe(94);
        expect(db.read('users/user-2')?.total_points).toBe(94);
        expect(db.read('tasks/t2')?.penaltyAccrual).toBeUndefined();
    });
});
