/**
 * MSG22 fix #2: pure helpers behind the PATCH seam-only save.
 *
 * isSimpleSeamOnlyEdit decides which updates may commit directly
 * through the primary adapter for a doc that exists only in the seam;
 * buildSeamOnlyEditImage builds the stored image for those edits.
 */
import { isSimpleSeamOnlyEdit, buildSeamOnlyEditImage } from '../seam-tasks-route';

const BEFORE = {
  title: 'Email Premium Proof — Oct 25 (post-reset)',
  status: 'pending',
  assigneeId: 'member-uid',
  chapterId: 'seds-ist-chapter',
  reviewerId: 'old-reviewer',
  reviewerIds: ['old-reviewer'],
  deadline: '2026-10-26T12:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
};

describe('isSimpleSeamOnlyEdit', () => {
  it('accepts a deadline edit with the status sent back unchanged (the dialog shape)', () => {
    expect(
      isSimpleSeamOnlyEdit(BEFORE, { deadline: '2026-11-03T08:30:00.000Z', status: 'pending' })
    ).toBe(true);
  });

  it('accepts an edit with no status at all', () => {
    expect(isSimpleSeamOnlyEdit(BEFORE, { title: 'New title' })).toBe(true);
  });

  it('refuses any status transition', () => {
    expect(isSimpleSeamOnlyEdit(BEFORE, { status: 'in-progress' })).toBe(false);
    expect(isSimpleSeamOnlyEdit(BEFORE, { status: 'submitted-for-review' })).toBe(false);
    expect(isSimpleSeamOnlyEdit(BEFORE, { status: 'completed' })).toBe(false);
  });

  it('refuses approved even when the stored status is legacy approved', () => {
    expect(isSimpleSeamOnlyEdit({ ...BEFORE, status: 'approved' }, { status: 'approved' })).toBe(false);
  });

  it('refuses workflow step writes and removals', () => {
    expect(isSimpleSeamOnlyEdit(BEFORE, { steps: [{ title: 's', assigneeId: 'u' }] })).toBe(false);
    expect(isSimpleSeamOnlyEdit(BEFORE, { removedStepIds: ['step-1'] })).toBe(false);
    expect(isSimpleSeamOnlyEdit(BEFORE, { steps: [], removedStepIds: [] })).toBe(true);
  });
});

describe('buildSeamOnlyEditImage', () => {
  const NOW = '2026-11-02T01:30:00.000Z';

  it('merges the update, stamps updatedAt, converts Dates to ISO', () => {
    const image = buildSeamOnlyEditImage(
      BEFORE,
      { deadline: new Date('2026-11-03T08:30:00.000Z'), status: 'pending' },
      NOW
    );
    expect(image.deadline).toBe('2026-11-03T08:30:00.000Z');
    expect(image.updatedAt).toBe(NOW);
    expect(image.title).toBe(BEFORE.title);
  });

  it('explicit null clears chapterId and both reviewer stamps', () => {
    const image = buildSeamOnlyEditImage(BEFORE, { chapterId: null, reviewerId: null }, NOW);
    expect('chapterId' in image).toBe(false);
    expect('reviewerId' in image).toBe(false);
    expect('reviewerIds' in image).toBe(false);
  });

  it('naming a reviewer keeps reviewerId and reviewerIds in sync', () => {
    const image = buildSeamOnlyEditImage(BEFORE, { reviewerId: 'new-reviewer' }, NOW);
    expect(image.reviewerId).toBe('new-reviewer');
    expect(image.reviewerIds).toEqual(['new-reviewer']);
  });

  it('never carries steps or removedStepIds onto the doc', () => {
    const image = buildSeamOnlyEditImage(BEFORE, { steps: [], removedStepIds: [] }, NOW);
    expect('steps' in image).toBe(false);
    expect('removedStepIds' in image).toBe(false);
  });
});
