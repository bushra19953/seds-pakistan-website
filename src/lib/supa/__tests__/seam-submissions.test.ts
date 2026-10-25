/**
 * @jest-environment node
 *
 * Seam tests for the tasks-cluster group-5 submissions join
 * (src/lib/supa/seam-submissions.ts). All adapter interaction is with
 * an INJECTED MOCK adapter — no live Supabase, no live Firestore.
 *
 * Contract pinned here:
 * - flag OFF / adapter absent -> enabled=false, join read=null,
 *   mirror=false, and the adapter's data functions are NEVER called.
 * - flag ON + mocked adapter -> task-join read returns the doc with
 *   timestamps normalized to the Firestore path's ISO-string shape.
 * - mirror-on-write: review decision mirrors submission update +
 *   linked competition + points_audit via the adapter; a throwing
 *   adapter yields false, never a throw.
 * - timestamp normalization: ISO string / Date / Timestamp-like /
 *   {seconds} all become ISO strings; garbage becomes null.
 */

import {
  __setSubmissionsAdapterForTests,
  supaTasksSurfaceEnabled,
  supaSurfacesInclude,
  supaGetTaskDoc,
  mirrorSubmissionReview,
  normalizeTimestampValue,
  normalizeTimestampFields,
  sanitizeForMirror,
  type SupaAdapterLike,
} from '../seam-submissions';

function mockAdapter(overrides: Partial<SupaAdapterLike> = {}): SupaAdapterLike {
  return {
    getDoc: jest.fn(async () => null),
    listDocs: jest.fn(async () => []),
    countDocs: jest.fn(async () => 0),
    setDoc: jest.fn(async () => ({})),
    updateDoc: jest.fn(async () => ({})),
    deleteDoc: jest.fn(async () => undefined),
    ...overrides,
  };
}

const onForTasks = (surface: string) => surface === 'tasks';
const offForAll = () => false;

afterEach(() => {
  __setSubmissionsAdapterForTests(undefined);
  delete process.env.SUPA_SURFACES;
});

describe('supaSurfacesInclude (matches adapter flags.ts semantics)', () => {
  test('comma list, case-insensitive, star wildcard', () => {
    expect(supaSurfacesInclude('tasks', 'tasks')).toBe(true);
    expect(supaSurfacesInclude('Events, TASKS ', 'tasks')).toBe(true);
    expect(supaSurfacesInclude('*', 'tasks')).toBe(true);
    expect(supaSurfacesInclude('events', 'tasks')).toBe(false);
    expect(supaSurfacesInclude('', 'tasks')).toBe(false);
    expect(supaSurfacesInclude(undefined, 'tasks')).toBe(false);
  });
});

describe('normalizeTimestampValue', () => {
  test('ISO string passes through normalized', () => {
    expect(normalizeTimestampValue('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
  });
  test('Date becomes ISO', () => {
    expect(normalizeTimestampValue(new Date('2026-01-02T03:04:05Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });
  test('Timestamp-like via toDate()', () => {
    expect(
      normalizeTimestampValue({ toDate: () => new Date('2026-01-02T03:04:05Z') }),
    ).toBe('2026-01-02T03:04:05.000Z');
  });
  test('{seconds,nanoseconds} shape', () => {
    expect(normalizeTimestampValue({ seconds: 1767227045, nanoseconds: 0 })).toBe(
      new Date(1767227045 * 1000).toISOString(),
    );
  });
  test('garbage and nullish become null', () => {
    expect(normalizeTimestampValue(null)).toBeNull();
    expect(normalizeTimestampValue(undefined)).toBeNull();
    expect(normalizeTimestampValue('not a date')).toBeNull();
    expect(normalizeTimestampValue(42)).toBeNull();
    expect(normalizeTimestampValue({ toDate: () => { throw new Error('x'); } })).toBeNull();
  });
  test('normalizeTimestampFields leaves absent fields absent', () => {
    const out = normalizeTimestampFields({ id: 'a', submittedAt: '2026-01-02T03:04:05Z' }, [
      'submittedAt',
      'deadline',
    ]);
    expect(out.submittedAt).toBe('2026-01-02T03:04:05.000Z');
    expect('deadline' in out).toBe(false);
  });
});

describe('sanitizeForMirror', () => {
  test('converts Date and Timestamp-like values, recurses plain data', () => {
    class Sentinel { __fv = 'serverTimestamp'; }
    const out = sanitizeForMirror({
      when: new Date('2026-01-02T03:04:05Z'),
      nested: { at: { toDate: () => new Date('2026-02-03T04:05:06Z') } },
      list: [1, 'x', null],
      sentinel: new Sentinel(),
    }) as Record<string, any>;
    expect(out.when).toBe('2026-01-02T03:04:05.000Z');
    expect(out.nested.at).toBe('2026-02-03T04:05:06.000Z');
    expect(out.list).toEqual([1, 'x', null]);
    expect(out.sentinel).toBeNull();
  });
});

describe('flag OFF / adapter unavailable', () => {
  test('no adapter injected resolvable -> disabled, null read, false mirror', async () => {
    __setSubmissionsAdapterForTests(null);
    expect(await supaTasksSurfaceEnabled()).toBe(false);
    expect(await supaGetTaskDoc('task-1')).toBeNull();
    await expect(
      mirrorSubmissionReview({
        submissionId: 'sub-1',
        status: 'approved',
        reviewedBy: 'rev-1',
        reviewerDisplayName: 'Rev',
        reviewNotes: null,
        pointsAwarded: 10,
        reviewedAtIso: '2026-01-02T03:04:05.000Z',
      }),
    ).resolves.toBe(false);
  });

  test('adapter present but flag OFF -> data functions never called', async () => {
    const adapter = mockAdapter();
    __setSubmissionsAdapterForTests(adapter, offForAll);
    expect(await supaTasksSurfaceEnabled()).toBe(false);
    expect(await supaGetTaskDoc('task-1')).toBeNull();
    await expect(
      mirrorSubmissionReview({
        submissionId: 'sub-1',
        status: 'rejected',
        reviewedBy: 'rev-1',
        reviewerDisplayName: 'Rev',
        reviewNotes: 'no',
        pointsAwarded: 0,
        reviewedAtIso: '2026-01-02T03:04:05.000Z',
      }),
    ).resolves.toBe(false);
    expect(adapter.getDoc).not.toHaveBeenCalled();
    expect(adapter.updateDoc).not.toHaveBeenCalled();
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });
});

describe('flag ON with mocked adapter: task-join read', () => {
  test('returns the task doc with every timestamp shape normalized to ISO', async () => {
    const adapter = mockAdapter({
      getDoc: jest.fn(async () => ({
        id: 'task-1',
        title: 'Build the thing',
        status: 'submitted-for-review',
        submittedAt: '2026-01-02T03:04:05Z',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        deadline: { toDate: () => new Date('2026-03-04T05:06:07Z') },
        points: 25,
      })),
    });
    __setSubmissionsAdapterForTests(adapter, onForTasks);
    expect(await supaTasksSurfaceEnabled()).toBe(true);
    const doc = await supaGetTaskDoc('task-1');
    expect(adapter.getDoc).toHaveBeenCalledWith('tasks', 'task-1');
    expect(doc).toMatchObject({
      id: 'task-1',
      title: 'Build the thing',
      status: 'submitted-for-review',
      submittedAt: '2026-01-02T03:04:05.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      deadline: '2026-03-04T05:06:07.000Z',
      points: 25,
    });
  });

  test('missing doc -> null; throwing adapter -> null (Firestore fallback)', async () => {
    __setSubmissionsAdapterForTests(mockAdapter(), onForTasks);
    expect(await supaGetTaskDoc('nope')).toBeNull();
    __setSubmissionsAdapterForTests(
      mockAdapter({
        getDoc: jest.fn(async () => {
          throw new Error('supa down');
        }),
      }),
      onForTasks,
    );
    expect(await supaGetTaskDoc('task-1')).toBeNull();
  });
});

describe('flag ON with mocked adapter: mirror-on-write', () => {
  const baseMirror = {
    submissionId: 'sub-1',
    status: 'approved',
    reviewedBy: 'rev-1',
    reviewerDisplayName: 'Reviewer Admin',
    reviewNotes: null as string | null,
    pointsAwarded: 10,
    reviewedAtIso: '2026-01-02T03:04:05.000Z',
  };

  test('approve decision mirrors submission update + competition + audit', async () => {
    const adapter = mockAdapter();
    __setSubmissionsAdapterForTests(adapter, onForTasks);
    const ok = await mirrorSubmissionReview({
      ...baseMirror,
      linkedCompetitionId: 'comp-1',
      competition: {
        title: 'Comp',
        deadline: { toDate: () => new Date('2026-05-06T07:08:09Z') },
        status: 'active',
      },
      auditId: 'audit-1',
      audit: { userId: 'member-1', delta: 10, reason: 'submission_approved' },
    });
    expect(ok).toBe(true);
    expect(adapter.updateDoc).toHaveBeenCalledWith('submissions', 'sub-1', {
      status: 'approved',
      reviewedAt: '2026-01-02T03:04:05.000Z',
      reviewedBy: 'rev-1',
      reviewerDisplayName: 'Reviewer Admin',
      reviewNotes: null,
      pointsAwarded: 10,
      linkedCompetitionId: 'comp-1',
    });
    expect(adapter.setDoc).toHaveBeenCalledWith(
      'competitions',
      'comp-1',
      expect.objectContaining({
        title: 'Comp',
        deadline: '2026-05-06T07:08:09.000Z',
        status: 'active',
        createdAt: '2026-01-02T03:04:05.000Z',
      }),
    );
    expect(adapter.setDoc).toHaveBeenCalledWith(
      'points_audit',
      'audit-1',
      expect.objectContaining({
        userId: 'member-1',
        delta: 10,
        reason: 'submission_approved',
        timestamp: '2026-01-02T03:04:05.000Z',
      }),
    );
  });

  test('reject decision mirrors only the submission update', async () => {
    const adapter = mockAdapter();
    __setSubmissionsAdapterForTests(adapter, onForTasks);
    const ok = await mirrorSubmissionReview({
      ...baseMirror,
      status: 'rejected',
      pointsAwarded: 0,
      reviewNotes: 'Not eligible',
    });
    expect(ok).toBe(true);
    expect(adapter.updateDoc).toHaveBeenCalledTimes(1);
    expect(adapter.setDoc).not.toHaveBeenCalled();
  });

  test('throwing adapter -> false, never throws', async () => {
    const adapter = mockAdapter({
      updateDoc: jest.fn(async () => {
        throw new Error('mirror boom');
      }),
    });
    __setSubmissionsAdapterForTests(adapter, onForTasks);
    await expect(mirrorSubmissionReview({ ...baseMirror })).resolves.toBe(false);
  });
});
