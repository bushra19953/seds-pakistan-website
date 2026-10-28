/**
 * @jest-environment node
 *
 * Named-reviewer resolution: uid fields only. resolveTaskReviewerUids
 * returns the deduped union of the task doc's `reviewerId` (lead) and
 * `reviewerIds` (all designated reviewers). Description text is never
 * read: a task whose description names a reviewer but carries no
 * fields resolves to NOBODY (founder ruling 2026-10-28: identity is
 * matched by email/uid, never by name).
 */
import { resolveTaskReviewerUids } from '../task-reviewer';

const LEAD = 'PB6yfB2UsngMvi1slAAHZeT7kOh1';
const CO = 'IPhLvckHJQgj5cZxr5nQESauH762';

const HASSAN_DESCRIPTION =
  '72-Hour Crucible task ROV-001. Pod: 3A. Candidate: Hassan Ali. ' +
  'Reviewer: Bushra Rahman (Lead Coder / Autonomy Lead) / Ahmed Ali Kamran (Chapter Vice President). ' +
  'Faculty patron: Prof. Dr. Najam Abbas Naqvi. Deliverable: a Docker image.';

describe('resolveTaskReviewerUids', () => {
  it('lead in reviewerId resolves', () => {
    expect(resolveTaskReviewerUids({ reviewerId: LEAD })).toEqual([LEAD]);
  });

  it('co-reviewer in reviewerIds resolves', () => {
    expect(resolveTaskReviewerUids({ reviewerIds: [CO] })).toEqual([CO]);
  });

  it('both fields present: union, lead first, deduped', () => {
    expect(
      resolveTaskReviewerUids({ reviewerId: LEAD, reviewerIds: [LEAD, CO, CO] })
    ).toEqual([LEAD, CO]);
  });

  it('reviewerIds alone with duplicates dedupes', () => {
    expect(resolveTaskReviewerUids({ reviewerIds: [CO, LEAD, CO] })).toEqual([CO, LEAD]);
  });

  it('PIN: a description naming reviewers but carrying NO fields resolves to nobody', () => {
    expect(resolveTaskReviewerUids({ description: HASSAN_DESCRIPTION } as any)).toEqual([]);
  });

  it('no reviewer fields yields []', () => {
    expect(resolveTaskReviewerUids({})).toEqual([]);
    expect(resolveTaskReviewerUids({ reviewerId: null, reviewerIds: null })).toEqual([]);
    expect(resolveTaskReviewerUids({ reviewerId: '', reviewerIds: [] })).toEqual([]);
  });

  it('malformed values are ignored, never thrown on', () => {
    expect(
      resolveTaskReviewerUids({
        reviewerId: 42,
        reviewerIds: ['  ', CO, 7, null, ` ${LEAD} `],
      } as any)
    ).toEqual([CO, LEAD]);
    expect(resolveTaskReviewerUids({ reviewerIds: 'not-an-array' } as any)).toEqual([]);
    expect(resolveTaskReviewerUids(null as any)).toEqual([]);
    expect(resolveTaskReviewerUids(undefined as any)).toEqual([]);
  });
});
