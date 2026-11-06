/**
 * @jest-environment node
 *
 * Bottleneck flag pass (Founder-approved design, 2026-11-06): an
 * overdue workflow step whose downstream step is still waiting gets
 * dependencyFlag 'AT_RISK_DEPENDENCY'; the flag clears when the block
 * ends. The pass must never create warnings, cases, miss records, or
 * point movements - it writes flag fields on task docs only.
 */
import { makeFakeDb } from '../discipline/__tests__/fake-firestore';
import { BOTTLENECK_FLAG, runBottleneckFlagPass } from '../workflow-bottleneck';

const NOW = new Date('2026-11-06T12:00:00.000Z');

function seedWorkflow(db: any, overrides: Record<string, any> = {}) {
    db.seed('tasks/step-1', {
        title: 'Step 1',
        status: 'overdue',
        workflowId: 'wf-1',
        sequenceIndex: 0,
        assigneeIds: ['user-1'],
        ...overrides,
    });
    db.seed('tasks/step-2', {
        title: 'Step 2',
        status: 'pending',
        workflowId: 'wf-1',
        sequenceIndex: 1,
        assigneeIds: ['user-2'],
        isCurrentStep: false,
        releasedAt: null,
    });
    db.seed('users/user-1', { displayName: 'U1', total_points: 50 });
}

describe('runBottleneckFlagPass', () => {
    test('flags the overdue step that blocks a waiting downstream step', async () => {
        const db = makeFakeDb();
        seedWorkflow(db);
        const summary = await runBottleneckFlagPass(db, NOW);
        expect(summary.flagged).toBe(1);
        const step1 = db.read('tasks/step-1');
        expect(step1?.dependencyFlag).toBe(BOTTLENECK_FLAG);
        expect(step1?.dependencyBlockedTaskId).toBe('step-2');
        expect(step1?.dependencyFlaggedAt).toBe(NOW.toISOString());
        // The downstream step itself is never flagged.
        expect(db.read('tasks/step-2')?.dependencyFlag).toBeUndefined();
    });

    test('a rerun while still blocked does not re-stamp the flag', async () => {
        const db = makeFakeDb();
        seedWorkflow(db);
        await runBottleneckFlagPass(db, NOW);
        const again = await runBottleneckFlagPass(db, new Date(NOW.getTime() + 3600000));
        expect(again.flagged).toBe(0);
        expect(again.stillFlagged).toBe(1);
        expect(db.read('tasks/step-1')?.dependencyFlaggedAt).toBe(NOW.toISOString());
    });

    test('no flag when the downstream step was already released', async () => {
        const db = makeFakeDb();
        seedWorkflow(db);
        db.seed('tasks/step-2', {
            title: 'Step 2',
            status: 'in-progress',
            workflowId: 'wf-1',
            sequenceIndex: 1,
            assigneeIds: ['user-2'],
            isCurrentStep: true,
            releasedAt: '2026-11-05T00:00:00.000Z',
        });
        const summary = await runBottleneckFlagPass(db, NOW);
        expect(summary.flagged).toBe(0);
        expect(db.read('tasks/step-1')?.dependencyFlag).toBeUndefined();
    });

    test('no flag when the downstream step is completed, and no flag for non-workflow tasks', async () => {
        const db = makeFakeDb();
        seedWorkflow(db, { workflowId: 'wf-1' });
        db.seed('tasks/step-2', {
            title: 'Step 2', status: 'completed', workflowId: 'wf-1', sequenceIndex: 1, assigneeIds: ['user-2'],
        });
        db.seed('tasks/plain', { title: 'Plain overdue', status: 'overdue', assigneeIds: ['user-1'] });
        const summary = await runBottleneckFlagPass(db, NOW);
        expect(summary.flagged).toBe(0);
        expect(db.read('tasks/plain')?.dependencyFlag).toBeUndefined();
    });

    test('the flag clears once the blocking step is submitted', async () => {
        const db = makeFakeDb();
        seedWorkflow(db);
        await runBottleneckFlagPass(db, NOW);
        expect(db.read('tasks/step-1')?.dependencyFlag).toBe(BOTTLENECK_FLAG);
        db.seed('tasks/step-1', {
            title: 'Step 1', status: 'submitted-for-review', workflowId: 'wf-1', sequenceIndex: 0,
            assigneeIds: ['user-1'], dependencyFlag: BOTTLENECK_FLAG,
            dependencyFlaggedAt: NOW.toISOString(), dependencyBlockedTaskId: 'step-2',
        });
        const summary = await runBottleneckFlagPass(db, new Date(NOW.getTime() + 3600000));
        expect(summary.cleared).toBe(1);
        const step1 = db.read('tasks/step-1');
        expect(step1?.dependencyFlag).toBeNull();
        expect(step1?.dependencyBlockedTaskId).toBeNull();
    });

    test('the pass issues no warnings and moves no points', async () => {
        const db = makeFakeDb();
        seedWorkflow(db);
        await runBottleneckFlagPass(db, NOW);
        expect(db.readCollection('users/user-1/warnings')).toHaveLength(0);
        expect(db.readCollection('disciplinary_cases')).toHaveLength(0);
        expect(db.readCollection('deadline_miss_records')).toHaveLength(0);
        expect(db.readCollection('points_ledger')).toHaveLength(0);
        expect(db.read('users/user-1')?.total_points).toBe(50);
    });
});
