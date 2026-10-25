/**
 * CONTRACT 2 — workflow progress equivalence (feat/supa-wf-3 surface).
 *
 * Pins the CURRENT Firestore-path semantics of the real
 * src/lib/workflow-progress.ts as the reference implementation:
 *
 *   work-done  = 'completed' | 'submitted-for-review'
 *   approved   = 'completed' ONLY
 *   progress%  = round(workDone / total * 100)
 *   isCompleted = total > 0 AND every step is 'completed'
 *
 * READ BEFORE UPDATING — 'approved':
 *   The status string 'approved' currently counts as NEITHER work-done NOR
 *   approved in computeWorkflowProgress (see the pinned rows below). The
 *   tasks team is unifying status semantics on fix/tasks-status-semantics;
 *   when that lands, the 'approved' rows in this suite are the ones that
 *   will need updating — deliberately, in that change, not silently here.
 *   Known divergence pinned below: task-pdf-adapter.ts treats 'approved'
 *   as done (COMPLETED_STATUSES), workflow-progress.ts does not.
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
  // PIN (current semantics): 'approved' counts for nothing in workflow-progress.
  { name: "single 'approved' (PIN: counts as neither done nor approved)", statuses: ['approved'], expect: { completedSteps: 0, approvedSteps: 0, progressPercentage: 0, isCompleted: false } },
  { name: "completed + 'approved' (PIN)", statuses: ['completed', 'approved'], expect: { completedSteps: 1, approvedSteps: 1, progressPercentage: 50, isCompleted: false } },
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
    expect: { completedSteps: 2, approvedSteps: 1, progressPercentage: 33, isCompleted: false },
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
    expect(isStepWorkDone('approved')).toBe(false); // PIN — see header note
    expect(isStepWorkDone('changes-requested')).toBe(false);
    expect(isStepWorkDone('in-progress')).toBe(false);
    expect(isStepWorkDone('pending')).toBe(false);
    expect(isStepWorkDone(null)).toBe(false);
    expect(isStepWorkDone(undefined)).toBe(false);
    expect(isStepApproved('completed')).toBe(true);
    expect(isStepApproved('approved')).toBe(false); // PIN — see header note
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

describe('contract 2: known divergence pin — task PDF adapter vs workflow-progress', () => {
  it("DIVERGENCE PIN: task-pdf-adapter treats 'approved' as done; workflow-progress does not", () => {
    const pdfData = taskToWorkflowPDFData({
      task: { id: 't1', title: 'Solo task', status: 'approved' },
      assignees: [{ id: 'u1', name: 'Huzaifah Shujjah' }],
    });
    // Current adapter behavior (COMPLETED_STATUSES = completed|approved):
    expect(pdfData.isCompleted).toBe(true);
    expect(pdfData.completedSteps).toBe(1);
    expect(pdfData.progressPercentage).toBe(100);
    // Current canonical progress behavior for the same status:
    expect(computeWorkflowProgress(['approved']).isCompleted).toBe(false);
    // When fix/tasks-status-semantics lands and unifies these, update BOTH
    // sides of this pin in that change.
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
