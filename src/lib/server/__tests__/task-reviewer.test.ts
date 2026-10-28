/**
 * @jest-environment node
 *
 * Named-reviewer resolution: the canonical reviewerId field wins; the
 * legacy record is the crucible template's "Reviewer:" line inside the
 * step description (the same line the mission PDF prints). Name
 * resolution is fail-closed: exactly one user doc with that
 * displayName resolves, zero or ambiguous matches resolve to nobody.
 */
const mockDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import { FakeFirestore } from '@/lib/__tests__/helpers/fake-firestore';
import { parseReviewerNames, resolveTaskReviewerUids } from '../task-reviewer';

let fake: FakeFirestore;

beforeEach(() => {
  fake = new FakeFirestore();
  mockDbHolder.db = fake.asDb();
});

describe('parseReviewerNames', () => {
  it('extracts both names from the crucible template line (Hassan step shape)', () => {
    const description =
      '72-Hour Crucible task ROV-001. Pod: 3A. Candidate: Hassan Ali. ' +
      'Reviewer: Bushra Rahman (Lead Coder / Autonomy Lead) / Ahmed Ali Kamran (Chapter Vice President). ' +
      'Faculty patron: Prof. Dr. Najam Abbas Naqvi. Deliverable: a Docker image.';
    expect(parseReviewerNames(description)).toEqual(['Bushra Rahman', 'Ahmed Ali Kamran']);
  });

  it('extracts a single reviewer and stops at the next label', () => {
    const description =
      'Do the thing. Reviewer: Muhammad Huzaifah Shujjah. Verification: countersigned log.';
    expect(parseReviewerNames(description)).toEqual(['Muhammad Huzaifah Shujjah']);
  });

  it('returns [] when there is no Reviewer segment', () => {
    expect(parseReviewerNames('Just a plain task with no template.')).toEqual([]);
    expect(parseReviewerNames('')).toEqual([]);
    expect(parseReviewerNames(undefined)).toEqual([]);
    expect(parseReviewerNames(null)).toEqual([]);
  });

  it('does not fire on "Reviewer:" glued inside another word', () => {
    expect(parseReviewerNames('The xReviewer: Nobody Here.')).toEqual([]);
  });
});

describe('resolveTaskReviewerUids', () => {
  it('reviewerId field wins and needs no name lookup', async () => {
    const uids = await resolveTaskReviewerUids(fake.asDb() as any, {
      reviewerId: 'uid-direct',
      description: 'Reviewer: Bushra Rahman.',
    });
    expect(uids).toEqual(['uid-direct']);
  });

  it('resolves description names to uids by exact displayName', async () => {
    fake.seed('users', 'uid-bushra', { displayName: 'Bushra Rahman' });
    fake.seed('users', 'uid-ahmed', { displayName: 'Ahmed Ali Kamran' });
    const uids = await resolveTaskReviewerUids(fake.asDb() as any, {
      description:
        'Reviewer: Bushra Rahman (Lead Coder / Autonomy Lead) / Ahmed Ali Kamran (Chapter Vice President). Faculty patron: Prof. X.',
    });
    expect(uids).toEqual(['uid-bushra', 'uid-ahmed']);
  });

  it('unknown names resolve to nobody (fail closed)', async () => {
    const uids = await resolveTaskReviewerUids(fake.asDb() as any, {
      description: 'Reviewer: Ghost Person.',
    });
    expect(uids).toEqual([]);
  });

  it('ambiguous names (two user docs, same displayName) resolve to nobody', async () => {
    fake.seed('users', 'uid-one', { displayName: 'Shared Name' });
    fake.seed('users', 'uid-two', { displayName: 'Shared Name' });
    const uids = await resolveTaskReviewerUids(fake.asDb() as any, {
      description: 'Reviewer: Shared Name.',
    });
    expect(uids).toEqual([]);
  });

  it('no reviewer anywhere yields []', async () => {
    expect(await resolveTaskReviewerUids(fake.asDb() as any, {})).toEqual([]);
    expect(
      await resolveTaskReviewerUids(fake.asDb() as any, { description: 'No template here.' })
    ).toEqual([]);
  });
});
