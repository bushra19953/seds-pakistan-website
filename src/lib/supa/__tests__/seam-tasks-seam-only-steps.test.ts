/**
 * MSG22 fix #3: the deadline-only own-step allowance behind the PATCH
 * seam-only save.
 *
 * A workflow-step task's dialog save always carries its Workflow Plan
 * steps. The allowance is deliberately narrow: steps must be exactly
 * [this task's own step] (identity = the step's id equals the id of
 * the task being saved), every non-deadline field of that step must
 * match the stored seam image (with the dialog's own normalizations:
 * a missing assigneeIds reads as [assigneeId], a null badge reads as
 * absent), and the only changes may be deadline-class fields
 * (deadline / individualDeadline) on that step.
 */
import {
  isSimpleSeamOnlyEdit,
  isDeadlineOnlyOwnStepEdit,
  buildSeamOnlyEditImage,
} from '../seam-tasks-route';

const TASK_ID = '0PlwdSbGfnaJIXfnWTFg';
const BEFORE = {
  title: 'Proof step',
  description: 'Proof that a plain workflow step works',
  status: 'pending',
  assigneeId: 'member-uid',
  assigneeIds: ['member-uid'],
  workflowId: 'wf_1792898150639_dsz835',
  deadline: '2026-10-26T12:00:00.000Z',
  individualDeadline: '2026-10-26T12:00:00.000Z',
  points: 10,
  stepSpecificBadgeId: null,
  resources: [] as any[],
  updatedAt: '2026-10-25T10:00:00.000Z',
};

function ownStep(overrides: Record<string, any> = {}) {
  return {
    id: TASK_ID,
    title: BEFORE.title,
    description: BEFORE.description,
    assigneeId: 'member-uid',
    assigneeIds: ['member-uid'],
    individualDeadline: '2026-11-03T08:30:00.000Z',
    resources: [],
    ...overrides,
  };
}

describe('isDeadlineOnlyOwnStepEdit', () => {
  it('accepts steps=[itself] with only the step override deadline changed', () => {
    expect(isDeadlineOnlyOwnStepEdit(BEFORE, { steps: [ownStep()] }, TASK_ID)).toBe(true);
  });

  it('accepts the dialog normalization where assigneeIds is omitted (reads as [assigneeId])', () => {
    const step = ownStep();
    delete (step as any).assigneeIds;
    expect(isDeadlineOnlyOwnStepEdit(BEFORE, { steps: [step] }, TASK_ID)).toBe(true);
  });

  it('refuses a step whose id is a different step', () => {
    expect(
      isDeadlineOnlyOwnStepEdit(BEFORE, { steps: [ownStep({ id: 'another-step' })] }, TASK_ID)
    ).toBe(false);
  });

  it('refuses a step with no id (own step unidentifiable)', () => {
    const step = ownStep();
    delete (step as any).id;
    expect(isDeadlineOnlyOwnStepEdit(BEFORE, { steps: [step] }, TASK_ID)).toBe(false);
  });

  it('refuses any additional step alongside its own', () => {
    expect(
      isDeadlineOnlyOwnStepEdit(
        BEFORE,
        { steps: [ownStep(), ownStep({ id: 'another-step' })] },
        TASK_ID
      )
    ).toBe(false);
  });

  it('refuses a non-deadline change on its own step', () => {
    expect(
      isDeadlineOnlyOwnStepEdit(BEFORE, { steps: [ownStep({ title: 'Other title' })] }, TASK_ID)
    ).toBe(false);
    expect(
      isDeadlineOnlyOwnStepEdit(
        BEFORE,
        { steps: [ownStep({ assigneeId: 'other-uid', assigneeIds: ['other-uid'] })] },
        TASK_ID
      )
    ).toBe(false);
    expect(
      isDeadlineOnlyOwnStepEdit(
        BEFORE,
        { steps: [ownStep({ stepSpecificBadgeId: 'badge-1' })] },
        TASK_ID
      )
    ).toBe(false);
    expect(
      isDeadlineOnlyOwnStepEdit(
        BEFORE,
        { steps: [ownStep({ resources: [{ type: 'link', url: 'https://x', title: 'x' }] })] },
        TASK_ID
      )
    ).toBe(false);
  });

  it('refuses an unknown extra field on its own step', () => {
    expect(
      isDeadlineOnlyOwnStepEdit(BEFORE, { steps: [ownStep({ status: 'completed' })] }, TASK_ID)
    ).toBe(false);
  });
});

describe('isSimpleSeamOnlyEdit with a taskId (fix #3 integration)', () => {
  it('accepts the deadline-only own-step payload', () => {
    expect(
      isSimpleSeamOnlyEdit(
        BEFORE,
        { status: 'pending', individualDeadline: '2026-11-03T08:30:00.000Z', steps: [ownStep()] },
        TASK_ID
      )
    ).toBe(true);
  });

  it('still refuses steps payloads without a taskId (fix #2 call shape)', () => {
    expect(isSimpleSeamOnlyEdit(BEFORE, { steps: [ownStep()] })).toBe(false);
  });

  it('still refuses a status transition riding along with the steps payload', () => {
    expect(
      isSimpleSeamOnlyEdit(BEFORE, { status: 'in-progress', steps: [ownStep()] }, TASK_ID)
    ).toBe(false);
  });

  it('still refuses removals riding along with the steps payload', () => {
    expect(
      isSimpleSeamOnlyEdit(
        BEFORE,
        { status: 'pending', steps: [ownStep()], removedStepIds: ['x'] },
        TASK_ID
      )
    ).toBe(false);
  });
});

describe('buildSeamOnlyEditImage with a validated own-step payload', () => {
  const NOW = '2026-11-02T01:30:00.000Z';

  it("folds the step's deadline fields into this doc's image and never stores steps", () => {
    const image = buildSeamOnlyEditImage(
      BEFORE,
      { status: 'pending', steps: [ownStep()] },
      NOW
    );
    expect(image.individualDeadline).toBe('2026-11-03T08:30:00.000Z');
    expect(image.deadline).toBe(BEFORE.deadline);
    expect('steps' in image).toBe(false);
    expect(image.updatedAt).toBe(NOW);
  });

  it('a task-level deadline wins over a conflicting step value (legacy batch order: the master update applies last)', () => {
    // The real dialog shape for the founder's edit: the admin changes
    // the dialog's main deadline field, while the persisted step's own
    // override stays at its stored value (persisted steps are exempt
    // from the form's deadline re-split). Legacy semantics resolve the
    // conflict for the task-level value, so the seam image must too.
    const image = buildSeamOnlyEditImage(
      BEFORE,
      {
        individualDeadline: '2026-11-03T08:30:00.000Z',
        steps: [ownStep({ individualDeadline: BEFORE.individualDeadline })],
      },
      NOW
    );
    expect(image.individualDeadline).toBe('2026-11-03T08:30:00.000Z');
  });

  it("the step's deadline lands when the task level does not carry that field", () => {
    const image = buildSeamOnlyEditImage(
      BEFORE,
      { deadline: '2026-11-03T08:30:00.000Z', steps: [ownStep()] },
      NOW
    );
    expect(image.individualDeadline).toBe('2026-11-03T08:30:00.000Z');
    expect(image.deadline).toBe('2026-11-03T08:30:00.000Z');
  });
});
