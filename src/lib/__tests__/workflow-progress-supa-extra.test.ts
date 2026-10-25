/**
 * WF-3 SUPPLEMENT to the wf-6 CONTRACT 2 equivalence suite
 * (workflow-progress-supa-equivalence.test.ts, copied byte-identical).
 *
 * Covers doc shapes the copied matrix does NOT exercise at doc level,
 * WITHOUT changing any pinned expectation of that suite:
 *  - a step doc whose `status` key is ABSENT (not null, not undefined-valued)
 *  - a true JSON round-trip (JSON.parse(JSON.stringify(...))), which is
 *    what an fs_* jsonb column actually does: undefined-valued keys are
 *    dropped entirely, so a missing status must still read as not-done
 *  - exact-match (case/whitespace-sensitive) status semantics, as the
 *    current Firestore reference implementation behaves
 *
 * Pinned semantics under test (unchanged):
 *   work-done = 'completed' | 'submitted-for-review'
 *   approved  = 'completed' ONLY  ('approved' counts as NEITHER — see the
 *   divergence pin in the copied suite; unification is owned by
 *   fix/tasks-status-semantics, not this branch.)
 */

import {
  computeWorkflowProgress,
  isStepWorkDone,
  isStepApproved,
} from '@/lib/workflow-progress';
import { toJsonb, ts } from './supa-wf-fixtures';

const statusesOf = (docs: Array<Record<string, any>>) => docs.map((d) => d.status);

describe('wf-3 supplement: missing-status doc shapes', () => {
  it('step doc with NO status key counts as not done / not approved (fs + jsonb)', () => {
    const fsDocs: Array<Record<string, any>> = [
      { id: 's0', createdAt: ts('2026-10-17T08:00:00.000Z') }, // no status key at all
      { id: 's1', status: 'completed', createdAt: ts('2026-10-17T08:00:00.000Z') },
    ];
    expect('status' in fsDocs[0]).toBe(false);

    const fromFs = computeWorkflowProgress(statusesOf(fsDocs));
    const fromJsonb = computeWorkflowProgress(statusesOf(toJsonb(fsDocs)));
    expect(fromJsonb).toEqual(fromFs);
    expect(fromFs).toEqual({
      totalSteps: 2,
      completedSteps: 1,
      approvedSteps: 1,
      progressPercentage: 50,
      isCompleted: false,
    });
  });

  it('true JSON round-trip drops undefined status keys; progress is identical', () => {
    const fsDocs: Array<Record<string, any>> = [
      { id: 's0', status: undefined, createdAt: ts('2026-10-17T08:00:00.000Z') },
      { id: 's1', status: null, createdAt: ts('2026-10-17T08:00:00.000Z') },
      { id: 's2', status: 'submitted-for-review', createdAt: ts('2026-10-17T08:00:00.000Z') },
    ];
    // What a jsonb column actually returns after storage:
    const jsonRoundTripped = JSON.parse(JSON.stringify(toJsonb(fsDocs)));
    expect('status' in jsonRoundTripped[0]).toBe(false); // key dropped, not null
    expect(jsonRoundTripped[1].status).toBeNull(); // explicit null survives

    const fromFs = computeWorkflowProgress(statusesOf(fsDocs));
    const fromJsonb = computeWorkflowProgress(statusesOf(jsonRoundTripped));
    expect(fromJsonb).toEqual(fromFs);
    expect(fromFs.completedSteps).toBe(1);
    expect(fromFs.approvedSteps).toBe(0);
    expect(fromFs.progressPercentage).toBe(33);
    expect(fromFs.isCompleted).toBe(false);
  });

  it('all-missing statuses: 0%, not completed, total still counts the steps', () => {
    const docs: Array<Record<string, any>> = [{ id: 'a' }, { id: 'b' }];
    const result = computeWorkflowProgress(statusesOf(toJsonb(docs)));
    expect(result).toEqual({
      totalSteps: 2,
      completedSteps: 0,
      approvedSteps: 0,
      progressPercentage: 0,
      isCompleted: false,
    });
  });
});

describe('wf-3 supplement: status matching is exact (current reference behaviour)', () => {
  it.each(['Completed', 'COMPLETED', ' completed', 'completed ', 'Submitted-For-Review', 'APPROVED'])(
    '%p counts as neither work-done nor approved',
    (status) => {
      expect(isStepWorkDone(status)).toBe(false);
      expect(isStepApproved(status)).toBe(false);
      expect(computeWorkflowProgress([status]).progressPercentage).toBe(0);
    },
  );
});
