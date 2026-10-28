/**
 * Tests for the leave handover journey: approval-time redirect-out
 * (src/lib/server/leave-redirect.ts) and return-time restore
 * (src/lib/server/leave-return.ts), exercised as ONE journey against
 * the real helpers with an in-memory Firestore fake.
 *
 * Contract under test:
 * - On approval with a covering officer named, the member's tasks in
 *   a restorable status whose deadline falls inside the leave window
 *   are reassigned to the officer and stamped redirectedFrom, the
 *   exact fields returnFromLeave reads.
 * - Tasks the return helper would never restore are never stamped:
 *   overdue (and every other non-restorable status) stays untouched.
 * - A task whose covering-officer assignment would fail the
 *   platform's own validation is skipped with a recorded reason,
 *   never forced: officer on leave / missing, workflow step whose
 *   officer is not a workflow participant.
 * - Return restores exactly the tasks the redirect stamped.
 *
 * The flag stamping that precedes the redirect in production (the
 * universal-review approval batch) is seeded directly here; that
 * half is covered by universal-review-leave.test.ts.
 */

jest.mock('firebase-admin', () => ({
    firestore: {
        FieldValue: {
            serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
            delete: () => ({ __fv: 'delete' }),
            arrayUnion: (...vals: any[]) => ({ __fv: 'arrayUnion', vals }),
            increment: (n: number) => ({ __fv: 'increment', n }),
        },
    },
}));

jest.mock('@/lib/supa-seams/hr-leave', () => ({
    isLeaveSupaEnabled: () => false,
    mirrorLeaveAuditSet: jest.fn(async () => true),
    mirrorLeaveRequestUpdate: jest.fn(async () => true),
    tryGetLeaveRequestRaw: jest.fn(async () => ({ status: 'error' })),
}));

jest.mock('@/lib/server/supa-identity-primary', () => ({
    identityPrimaryFlagOn: jest.fn(async () => false),
    primaryIdentityUpdate: jest.fn(async () => undefined),
}));

import { redirectTasksForLeave } from '../leave-redirect';
import { returnFromLeave } from '../leave-return';

// ----------------------------------------------------------------
// In-memory Firestore fake: the subset both helpers use.
// ----------------------------------------------------------------

type DocData = Record<string, any>;

const store = new Map<string, DocData>();
let autoId = 0;

function isSentinel(value: any, kind: string): boolean {
    return value !== null && typeof value === 'object' && value.__fv === kind;
}

function applyData(existing: DocData, data: DocData): DocData {
    const next = { ...existing };
    for (const [key, value] of Object.entries(data)) {
        if (isSentinel(value, 'delete')) {
            delete next[key];
        } else if (isSentinel(value, 'serverTimestamp')) {
            next[key] = 'SERVER_TIMESTAMP';
        } else {
            next[key] = value;
        }
    }
    return next;
}

function makeRef(path: string): any {
    const id = path.split('/').pop() as string;
    return {
        id,
        path,
        get: async () => {
            const data = store.get(path);
            return { exists: data !== undefined, id, data: () => data };
        },
        set: async (data: any, opts?: any) => {
            store.set(path, opts?.merge ? applyData(store.get(path) ?? {}, data) : applyData({}, data));
        },
        update: async (data: any) => {
            store.set(path, applyData(store.get(path) ?? {}, data));
        },
        collection: (sub: string) => makeCollection(`${path}/${sub}`),
    };
}

function makeQuery(path: string, filters: Array<{ field: string; op: string; value: any }>): any {
    return {
        where: (field: string, op: string, value: any) => makeQuery(path, [...filters, { field, op, value }]),
        get: async () => {
            const docs: any[] = [];
            for (const [p, data] of store.entries()) {
                if (!p.startsWith(`${path}/`)) continue;
                const rest = p.slice(path.length + 1);
                if (rest.includes('/')) continue;
                const matches = filters.every((f) => {
                    if (f.op === '==') return data[f.field] === f.value;
                    if (f.op === 'array-contains') return Array.isArray(data[f.field]) && data[f.field].includes(f.value);
                    return false;
                });
                if (matches) docs.push({ id: rest, ref: makeRef(p), data: () => data });
            }
            return { docs, empty: docs.length === 0 };
        },
    };
}

function makeCollection(path: string): any {
    return {
        doc: (id?: string) => makeRef(`${path}/${id ?? `auto-${++autoId}`}`),
        where: (field: string, op: string, value: any) => makeQuery(path, [{ field, op, value }]),
    };
}

const fakeDb: any = {
    collection: (name: string) => makeCollection(name),
    batch: () => {
        const ops: Array<() => void> = [];
        return {
            set: (ref: any, data: any, opts?: any) => {
                ops.push(() => {
                    store.set(ref.path, opts?.merge ? applyData(store.get(ref.path) ?? {}, data) : applyData({}, data));
                });
            },
            update: (ref: any, data: any) => {
                ops.push(() => {
                    store.set(ref.path, applyData(store.get(ref.path) ?? {}, data));
                });
            },
            commit: async () => {
                for (const op of ops) op();
            },
        };
    },
};

// ----------------------------------------------------------------
// Seeds and inspection helpers.
// ----------------------------------------------------------------

const MEMBER = 'member-1';
const OFFICER = 'officer-1';
const LEAVE_ID = 'leave-1';
const WINDOW = { windowStart: '2026-10-20', windowEnd: '2026-10-24' };

function seedBase(): void {
    store.set(`users/${MEMBER}`, {
        displayName: 'Member One',
        isOnVacation: true,
        vacationMode: true,
        coveringOfficerId: OFFICER,
        vacationStartDate: '2026-10-20',
        vacationEndDate: '2026-10-24',
        leaveRequestId: LEAVE_ID,
    });
    store.set(`users/${OFFICER}`, { displayName: 'Officer One' });
    store.set(`leave_requests/${LEAVE_ID}`, {
        userId: MEMBER,
        status: 'approved',
        leaveType: 'emergency',
        startDate: '2026-10-20',
        endDate: '2026-10-24',
        coveringOfficerId: OFFICER,
    });
}

function seedTask(id: string, data: DocData): void {
    store.set(`tasks/${id}`, { assigneeId: MEMBER, ...data });
}

function task(id: string): DocData {
    return store.get(`tasks/${id}`) as DocData;
}

function activityEntries(taskId: string): DocData[] {
    const prefix = `tasks/${taskId}/activity/`;
    const entries: DocData[] = [];
    for (const [p, data] of store.entries()) {
        if (p.startsWith(prefix)) entries.push(data);
    }
    return entries;
}

function auditEntries(action?: string): DocData[] {
    const entries: DocData[] = [];
    for (const [p, data] of store.entries()) {
        if (p.startsWith('leave_audit/') && (action === undefined || data.action === action)) {
            entries.push(data);
        }
    }
    return entries;
}

function redirect(overrides: Record<string, any> = {}): Promise<any> {
    return redirectTasksForLeave(fakeDb, {
        memberUid: MEMBER,
        coveringOfficerId: OFFICER,
        leaveRequestId: LEAVE_ID,
        actorId: 'reviewer-1',
        ...WINDOW,
        ...overrides,
    });
}

function skipReason(result: any, taskId: string): string | undefined {
    return result.skipped.find((s: any) => s.taskId === taskId)?.reason;
}

beforeEach(() => {
    store.clear();
    autoId = 0;
});

// ----------------------------------------------------------------
// Redirect on approval.
// ----------------------------------------------------------------

describe('redirectTasksForLeave', () => {
    test('redirects an in-window pending task to the covering officer and stamps redirectedFrom', async () => {
        seedBase();
        seedTask('t-1', { status: 'pending', deadline: '2026-10-22' });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual(['t-1']);
        expect(result.skipped).toEqual([]);
        expect(result.coveringOfficerAvailable).toBe(true);
        expect(task('t-1').assigneeId).toBe(OFFICER);
        expect(task('t-1').redirectedFrom).toBe(MEMBER);

        const activity = activityEntries('t-1');
        expect(activity).toHaveLength(1);
        expect(activity[0].type).toBe('reassign');
        expect(activity[0].userId).toBe('reviewer-1');
        expect(activity[0].data.previousAssigneeId).toBe(MEMBER);
        expect(activity[0].data.newAssigneeId).toBe(OFFICER);
        expect(activity[0].data.leaveRequestId).toBe(LEAVE_ID);

        const audits = auditEntries('leave_tasks_redirected');
        expect(audits).toHaveLength(1);
        expect(audits[0].targetUid).toBe(MEMBER);
        expect(audits[0].coveringOfficerId).toBe(OFFICER);
        expect(audits[0].leaveRequestId).toBe(LEAVE_ID);
        expect(audits[0].redirectedTaskIds).toEqual(['t-1']);
        expect(audits[0].skipped).toEqual([]);
    });

    test('uses individualDeadline over deadline for the window check', async () => {
        seedBase();
        seedTask('t-1', { status: 'in_progress', deadline: '2026-12-01', individualDeadline: '2026-10-24T10:00:00Z' });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual(['t-1']);
        expect(task('t-1').assigneeId).toBe(OFFICER);
    });

    test('an overdue task is never redirected and stays untouched', async () => {
        seedBase();
        seedTask('t-overdue', { status: 'overdue', deadline: '2026-10-22' });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual([]);
        expect(skipReason(result, 't-overdue')).toBe('status_not_restorable');
        expect(task('t-overdue').assigneeId).toBe(MEMBER);
        expect(task('t-overdue')).not.toHaveProperty('redirectedFrom');
        expect(activityEntries('t-overdue')).toHaveLength(0);
    });

    test('completed and submitted-for-review tasks are not redirected (return would not restore them)', async () => {
        seedBase();
        seedTask('t-done', { status: 'completed', deadline: '2026-10-22' });
        seedTask('t-review', { status: 'submitted-for-review', deadline: '2026-10-22' });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual([]);
        expect(skipReason(result, 't-done')).toBe('status_not_restorable');
        expect(skipReason(result, 't-review')).toBe('status_not_restorable');
        expect(task('t-done').assigneeId).toBe(MEMBER);
        expect(task('t-review').assigneeId).toBe(MEMBER);
    });

    test('deadline outside the window and missing deadline are skipped with distinct reasons', async () => {
        seedBase();
        seedTask('t-late', { status: 'pending', deadline: '2026-11-05' });
        seedTask('t-early', { status: 'pending', deadline: '2026-10-01' });
        seedTask('t-none', { status: 'pending' });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual([]);
        expect(skipReason(result, 't-late')).toBe('deadline_outside_window');
        expect(skipReason(result, 't-early')).toBe('deadline_outside_window');
        expect(skipReason(result, 't-none')).toBe('no_deadline');
        expect(task('t-late').assigneeId).toBe(MEMBER);
        expect(task('t-none').assigneeId).toBe(MEMBER);
    });

    test('a task still carrying a redirectedFrom stamp is skipped, not re-stamped', async () => {
        seedBase();
        // The stamp is still on the task (for example an admin moved
        // it back by hand without clearing it). The member is the
        // assignee of record, so the task IS in the redirect query;
        // the guard keeps the helper from stamping it a second time
        // and stranding the original handover record.
        seedTask('t-1', { status: 'pending', deadline: '2026-10-22', redirectedFrom: MEMBER });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual([]);
        expect(skipReason(result, 't-1')).toBe('already_redirected');
        expect(task('t-1').assigneeId).toBe(MEMBER);
        expect(task('t-1').redirectedFrom).toBe(MEMBER);
        expect(activityEntries('t-1')).toHaveLength(0);
    });

    test('workflow step: officer as participant is redirected, officer not a participant is skipped', async () => {
        seedBase();
        seedTask('t-wf-ok', {
            status: 'pending',
            deadline: '2026-10-21',
            workflowId: 'wf-1',
            workflowParticipantIds: [MEMBER, OFFICER, 'other-1'],
        });
        seedTask('t-wf-blocked', {
            status: 'pending',
            deadline: '2026-10-21',
            workflowId: 'wf-1',
            workflowParticipantIds: [MEMBER, 'other-1'],
        });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual(['t-wf-ok']);
        expect(task('t-wf-ok').assigneeId).toBe(OFFICER);
        expect(skipReason(result, 't-wf-blocked')).toBe('covering_officer_not_workflow_participant');
        expect(task('t-wf-blocked').assigneeId).toBe(MEMBER);
        expect(task('t-wf-blocked')).not.toHaveProperty('redirectedFrom');
    });

    test('covering officer on leave: every eligible task skipped as unavailable, nothing forced', async () => {
        seedBase();
        store.set(`users/${OFFICER}`, { displayName: 'Officer One', isOnVacation: true, vacationMode: true });
        seedTask('t-1', { status: 'pending', deadline: '2026-10-22' });
        seedTask('t-overdue', { status: 'overdue', deadline: '2026-10-22' });

        const result = await redirect();

        expect(result.coveringOfficerAvailable).toBe(false);
        expect(result.redirectedTaskIds).toEqual([]);
        expect(skipReason(result, 't-1')).toBe('covering_officer_unavailable');
        // A task ineligible for its own reason keeps that reason.
        expect(skipReason(result, 't-overdue')).toBe('status_not_restorable');
        expect(task('t-1').assigneeId).toBe(MEMBER);
        expect(task('t-1')).not.toHaveProperty('redirectedFrom');
    });

    test('covering officer record missing: tasks skipped as unavailable', async () => {
        seedBase();
        store.delete(`users/${OFFICER}`);
        seedTask('t-1', { status: 'pending', deadline: '2026-10-22' });

        const result = await redirect();

        expect(result.coveringOfficerAvailable).toBe(false);
        expect(result.redirectedTaskIds).toEqual([]);
        expect(skipReason(result, 't-1')).toBe('covering_officer_unavailable');
    });

    test('the injected eligibility check is authoritative (the route passes validateUserStatus)', async () => {
        seedBase();
        seedTask('t-1', { status: 'pending', deadline: '2026-10-22' });

        const denied = await redirect({
            checkAssigneeEligible: async () => ({ isValid: false, error: 'User is currently on vacation' }),
        });
        expect(denied.redirectedTaskIds).toEqual([]);
        const deniedSkip = denied.skipped.find((s: any) => s.taskId === 't-1');
        expect(deniedSkip.reason).toBe('covering_officer_unavailable');
        expect(deniedSkip.detail).toBe('User is currently on vacation');
        expect(task('t-1').assigneeId).toBe(MEMBER);

        // And a passing injected check redirects even when the stored
        // officer doc carries vacation flags, because the platform
        // gate, not this helper, owns that judgement at the call site.
        store.set(`users/${OFFICER}`, { displayName: 'Officer One', isOnVacation: true });
        const allowed = await redirect({
            checkAssigneeEligible: async () => ({ isValid: true }),
        });
        expect(allowed.redirectedTaskIds).toEqual(['t-1']);
        expect(task('t-1').assigneeId).toBe(OFFICER);
    });

    test('tasks of other members are never touched', async () => {
        seedBase();
        seedTask('t-mine', { status: 'pending', deadline: '2026-10-22' });
        store.set('tasks/t-theirs', { assigneeId: 'other-1', status: 'pending', deadline: '2026-10-22' });

        const result = await redirect();

        expect(result.redirectedTaskIds).toEqual(['t-mine']);
        expect(store.get('tasks/t-theirs')?.assigneeId).toBe('other-1');
        expect(result.skipped.find((s: any) => s.taskId === 't-theirs')).toBeUndefined();
    });

    test('an empty covering officer id is a caller error, never a silent no-op', async () => {
        seedBase();
        await expect(redirect({ coveringOfficerId: '' })).rejects.toThrow('coveringOfficerId is required');
        await expect(redirect({ coveringOfficerId: '   ' })).rejects.toThrow('coveringOfficerId is required');
    });
});

// ----------------------------------------------------------------
// The full journey: approval redirect, then return restore.
// ----------------------------------------------------------------

describe('leave handover journey: redirect on approval, restore on return', () => {
    test('return restores exactly the tasks the redirect stamped', async () => {
        seedBase();
        seedTask('t-pending', { status: 'pending', deadline: '2026-10-22' });
        seedTask('t-progress', { status: 'in_progress', individualDeadline: '2026-10-23' });
        seedTask('t-hyphen', { status: 'in-progress', deadline: '2026-10-21' });
        seedTask('t-locked', { status: 'locked', deadline: '2026-10-20' });
        seedTask('t-wf', {
            status: 'pending',
            deadline: '2026-10-21',
            workflowId: 'wf-1',
            workflowParticipantIds: [MEMBER, OFFICER],
        });
        seedTask('t-overdue', { status: 'overdue', deadline: '2026-10-22' });
        seedTask('t-outside', { status: 'pending', deadline: '2026-12-01' });

        const redirectResult = await redirect();
        expect([...redirectResult.redirectedTaskIds].sort()).toEqual(
            ['t-hyphen', 't-locked', 't-pending', 't-progress', 't-wf'],
        );
        for (const id of redirectResult.redirectedTaskIds) {
            expect(task(id).assigneeId).toBe(OFFICER);
            expect(task(id).redirectedFrom).toBe(MEMBER);
        }

        const returnResult = await returnFromLeave(fakeDb, { uid: MEMBER, actorId: MEMBER });

        expect(returnResult.restoredCount).toBe(5);
        expect(returnResult.requestCompleted).toBe(true);
        for (const id of redirectResult.redirectedTaskIds) {
            expect(task(id).assigneeId).toBe(MEMBER);
            expect(task(id)).not.toHaveProperty('redirectedFrom');
        }
        // Never redirected, never restored: untouched by both halves.
        expect(task('t-overdue').assigneeId).toBe(MEMBER);
        expect(task('t-overdue')).not.toHaveProperty('redirectedFrom');
        expect(task('t-outside').assigneeId).toBe(MEMBER);
        expect(task('t-outside')).not.toHaveProperty('redirectedFrom');

        const user = store.get(`users/${MEMBER}`) as DocData;
        expect(user.isOnVacation).toBe(false);
        expect(user.vacationMode).toBe(false);
        expect(user).not.toHaveProperty('leaveRequestId');
        expect((store.get(`leave_requests/${LEAVE_ID}`) as DocData).status).toBe('completed');

        expect(auditEntries('leave_tasks_redirected')).toHaveLength(1);
        expect(auditEntries('leave_returned')).toHaveLength(1);
    });

    test('a second return after the journey is a no-op', async () => {
        seedBase();
        seedTask('t-1', { status: 'pending', deadline: '2026-10-22' });

        await redirect();
        const first = await returnFromLeave(fakeDb, { uid: MEMBER, actorId: MEMBER });
        expect(first.restoredCount).toBe(1);

        const second = await returnFromLeave(fakeDb, { uid: MEMBER, actorId: MEMBER });
        expect(second.alreadyReturned).toBe(true);
        expect(second.restoredCount).toBe(0);
        expect(task('t-1').assigneeId).toBe(MEMBER);
        expect(auditEntries('leave_returned')).toHaveLength(1);
    });
});
