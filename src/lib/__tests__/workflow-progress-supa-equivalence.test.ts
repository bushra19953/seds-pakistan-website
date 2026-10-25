/**
 * CONTRACT 2 — workflow progress equivalence (feat/supa-wf-3 surface).
 *
 * Pins the CURRENT Firestore-path semantics of the real
 * src/lib/workflow-progress.ts as the reference implementation:
 *
 *   work-done  = 'completed' | 'approved' | 'submitted-for-review'
 *   approved   = 'completed' | 'approved'   (post-1a semantics)
 *   progress%  = round(workDone / total * 100)
 *   isCompleted = total > 0 AND every step is approved
 *
 * HISTORY — 'approved': before step 17 this suite pinned 'approved' as
 * counting for nothing. fix/tasks-status-semantics (1a) landed at step 17
 * and unified the semantics: approvals are WRITTEN as 'completed' only,
 * and readers honor the legacy 'approved' spelling as done + approved.
 * The 'approved' rows below were updated deliberately in that step, per
 * this header's original instruction.
 *
 * Equivalence claim: statuses read from Firestore-shaped docs and from
 * jsonb-round-tripped docs (timestamps as ISO strings; statuses are plain
 * strings and survive verbatim) must yield identical progress objects.
 */

import {
  computeWorkflowProgress,
  isStepWorkDone,
  isStepApproved,
} from '@/lib/workflow-progress';
import { taskToWorkflowPDFData } from '@/lib/task-pdf-adapter';
import { toJsonb, ts } from './supa-wf-fixtures';

interface MixExpectation {
  completedSteps: number;
  approvedSteps: number;
  progressPercentage: number;
  isCompleted: boolean;
}

const MATRIX: Array<{ name: string; statuses: Array<string | null | undefined>; expect: MixExpectation }> = [
  { name: 'empty workflow', statuses: [], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  { name: 'single completed', statuses: ['completed'], expect: { completedSteps: 1, approvedSteps: 1, progressPercentage: 100, isCompleted: true } },
  { name: 'all completed', statuses: ['completed', 'completed', 'completed'], expect: { completedSteps: 3, approvedSteps: 3, progressPercentage: 100, isCompleted: true } },
  // UPDATED AT STEP 17 (deliberate, per the merge plan): 1a
  // (fix/tasks-status-semantics) made legacy 'approved' count as work-done
  // AND approved (isStepWorkDone/isStepApproved in workflow-progress.ts);
  // approvals are never WRITTEN as 'approved' anymore.
  { name: "single 'approved' (post-1a: counts as done and approved)", statuses: ['approved'], expect: { completedSteps: 1, approvedSteps: 1, progressPercentage: 100, isCompleted: true } },
  { name: "completed + 'approved' (post-1a)", statuses: ['completed', 'approved'], expect: { completedSteps: 2, approvedSteps: 2, progressPercentage: 100, isCompleted: true } },
  { name: 'single submitted-for-review (done, not approved)', statuses: ['submitted-for-review'], expect: { completedSteps: 1, approvedSteps: 0, progressPercentage: 100, isCompleted: false } },
  { name: 'all submitted-for-review: 100% progress but NOT completed', statuses: ['submitted-for-review', 'submitted-for-review'], expect: { completedSteps: 2, approvedSteps: 0, progressPercentage: 100, isCompleted: false } },
  { name: 'completed + submitted-for-review', statuses: ['completed', 'submitted-for-review'], expect: { completedSteps: 2, approvedSteps: 1, progressPercentage: 100, isCompleted: false } },
  { name: 'single changes-requested', statuses: ['changes-requested'], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  { name: 'single in-progress', statuses: ['in-progress'], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  { name: 'single pending', statuses: ['pending'], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  { name: 'single overdue', statuses: ['overdue'], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  {
    name: 'full six-status mix',
    statuses: ['completed', 'approved', 'submitted-for-review', 'changes-requested', 'in-progress', 'pending'],
    expect: { completedSteps: 3, approvedSteps: 2, progressPercentage: 50, isCompleted: false },
  },
  { name: 'null / undefined / empty statuses', statuses: [null, undefined, ''], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  { name: 'rounding: 1 of 3 done = 33%', statuses: ['completed', 'pending', 'pending'], expect: { completedSteps: 1, approvedSteps: 1, progressPercentage: 33, isCompleted: false } },
  { name: 'rounding: 2 of 3 done = 67%', statuses: ['completed', 'submitted-for-review', 'pending'], expect: { completedSteps: 2, approvedSteps: 1, progressPercentage: 67, isCompleted: false } },
];

describe('contract 2: computeWorkflowProgress pinned semantics (Firestore reference)', () => {
  it.each(MATRIX)('$name', ({ statuses, expect: exp }) => {
    const result = computeWorkflowProgress(statuses);
    expect(result.totalSteps).toBe(statuses.length);
    expect(result.completedSteps).toBe(exp.completedSteps);
    expect(result.approvedSteps).toBe(exp.approvedSteps);
    expect(result.progressPercentage).toBe(exp.progressPercentage);
    expect(result.isCompleted).toBe(exp.isCompleted);
  });

  it('isStepWorkDone / isStepApproved unit pins', () => {
    expect(isStepWorkDone('completed')).toBe(true);
    expect(isStepWorkDone('submitted-for-review')).toBe(true);
    expect(isStepWorkDone('approved')).toBe(true); // post-1a — see header note
    expect(isStepWorkDone('changes-requested')).toBe(false);
    expect(isStepWorkDone('in-progress')).toBe(false);
    expect(isStepWorkDone('pending')).toBe(false);
    expect(isStepWorkDone(null)).toBe(false);
    expect(isStepWorkDone(undefined)).toBe(false);
    expect(isStepApproved('completed')).toBe(true);
    expect(isStepApproved('approved')).toBe(true); // post-1a — see header note
    expect(isStepApproved('submitted-for-review')).toBe(false);
  });
});

describe('contract 2: Firestore-shaped docs vs jsonb-round-tripped docs', () => {
  it.each(MATRIX)('identical progress for: $name', ({ statuses, expect: exp }) => {
    // Firestore-shaped step docs (Timestamp objects ride along, as in prod).
    const fsDocs = statuses.map((status, i) => ({
      id: `s${i}`,
      status,
      createdAt: ts('2026-10-17T08:00:00.000Z'),
      completedAt: ts('2026-10-18T09:30:00.000Z'),
    }));
    const jsonbDocs = toJsonb(fsDocs);

    // Sanity: the round-trip really did change the timestamp representation.
    expect(typeof (jsonbDocs[0] as any)?.createdAt).toBe(
      statuses.length ? 'string' : 'undefined',
    );

    const fromFs = computeWorkflowProgress(fsDocs.map((d) => d.status));
    const fromJsonb = computeWorkflowProgress(jsonbDocs.map((d: any) => d.status));
    expect(fromJsonb).toEqual(fromFs);
    expect(fromJsonb.completedSteps).toBe(exp.completedSteps);
    expect(fromJsonb.progressPercentage).toBe(exp.progressPercentage);
    expect(fromJsonb.isCompleted).toBe(exp.isCompleted);
  });
});

describe('contract 2: convergence pin (post-1a) — task PDF adapter vs workflow-progress', () => {
  it("CONVERGENCE PIN (post-1a): task-pdf-adapter and workflow-progress agree on 'approved'", () => {
    const pdfData = taskToWorkflowPDFData({
      task: { id: 't1', title: 'Solo task', status: 'approved' },
      assignees: [{ id: 'u1', name: 'Huzaifah Shujjah' }],
    });
    // Current adapter behavior (COMPLETED_STATUSES = completed|approved):
    expect(pdfData.isCompleted).toBe(true);
    expect(pdfData.completedSteps).toBe(1);
    expect(pdfData.progressPercentage).toBe(100);
    // Canonical progress behavior for the same status — unified at step 17
    // when fix/tasks-status-semantics landed (both sides of the old
    // divergence pin updated in that change, as instructed):
    expect(computeWorkflowProgress(['approved']).isCompleted).toBe(true);
  });

  it('both paths agree on completed / submitted-for-review / pending', () => {
    for (const [status, done] of [['completed', true], ['submitted-for-review', false], ['pending', false]] as const) {
      const pdfData = taskToWorkflowPDFData({
        task: { id: 't1', title: 'Solo task', status },
        assignees: [],
      });
      expect(pdfData.isCompleted).toBe(done);
      expect(computeWorkflowProgress([status]).isCompleted).toBe(done);
    }
  });
});
