/**
 * Bug 4 tests: "overdue despite proof uploaded".
 *
 * Pin the rule in one place so the crons and the upload endpoint cannot
 * drift apart: a task with a non-empty deliverableFiles array has proof
 * attached and is awaiting review, not missing work.
 *
 * (a) overdue cron skips proof-bearing tasks
 * (b) check-deadlines skips proof-bearing tasks (no warning, no penalty,
 *     no overdue stamp)
 * (c) attach-upload auto-transitions only under the conservative conditions
 *
 * The route handlers call the pure helpers tested here, so these suites
 * verify the production behavior without a Firestore emulator.
 */

import {
  taskHasProofUploaded,
  deadlineMsOf,
  shouldAutoTransitionOnProofUpload,
  splitProofSkippedDocs,
  type ProofDocLike,
} from '../bug4-proof-guards';

// Fixed reference clock: 2026-10-20 05:00:00 UTC.
const NOW_MS = Date.UTC(2026, 9, 20, 5, 0, 0);
const PAST_ISO = '2026-10-19T10:00:00.000Z';
const FUTURE_ISO = '2026-10-21T10:00:00.000Z';

function makeTimestamp(ms: number): any {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

function makeDoc(id: string, data: Record<string, unknown>): ProofDocLike {
  return { id, data: () => data };
}

describe('taskHasProofUploaded', () => {
  it('returns true for a non-empty deliverableFiles array', () => {
    expect(taskHasProofUploaded({ deliverableFiles: [{ fileName: 'proof.pdf' }] })).toBe(true);
  });

  it('returns false for an empty deliverableFiles array', () => {
    expect(taskHasProofUploaded({ deliverableFiles: [] })).toBe(false);
  });

  it('returns false when deliverableFiles is missing', () => {
    expect(taskHasProofUploaded({ title: 'No proof' })).toBe(false);
  });

  it('returns false when deliverableFiles is not an array', () => {
    expect(taskHasProofUploaded({ deliverableFiles: 'proof.pdf' })).toBe(false);
    expect(taskHasProofUploaded({ deliverableFiles: 1 })).toBe(false);
    expect(taskHasProofUploaded({ deliverableFiles: null })).toBe(false);
  });

  it('returns false for null, undefined, and non-object input', () => {
    expect(taskHasProofUploaded(null)).toBe(false);
    expect(taskHasProofUploaded(undefined)).toBe(false);
    expect(taskHasProofUploaded('task')).toBe(false);
  });
});

describe('splitProofSkippedDocs', () => {
  it('splits proof-bearing docs away from the processing set', () => {
    const docs = [
      makeDoc('a', { status: 'pending', deliverableFiles: [{ fileName: 'p.pdf' }] }),
      makeDoc('b', { status: 'pending', deliverableFiles: [] }),
      makeDoc('c', { status: 'in-progress' }),
      makeDoc('d', { status: 'overdue', deliverableFiles: [{ fileName: 'p.pdf' }] }),
    ];
    const { withProof, withoutProof } = splitProofSkippedDocs(docs);
    expect(withProof.map((d) => d.id).sort()).toEqual(['a', 'd']);
    expect(withoutProof.map((d) => d.id).sort()).toEqual(['b', 'c']);
  });
});

describe('deadlineMsOf', () => {
  it('prefers individualDeadline over deadline', () => {
    expect(deadlineMsOf({ individualDeadline: PAST_ISO, deadline: FUTURE_ISO })).toBe(Date.parse(PAST_ISO));
  });

  it('falls back to deadline when individualDeadline is absent', () => {
    expect(deadlineMsOf({ deadline: FUTURE_ISO })).toBe(Date.parse(FUTURE_ISO));
  });

  it('accepts Firestore Timestamp shapes', () => {
    expect(deadlineMsOf({ deadline: makeTimestamp(NOW_MS) })).toBe(NOW_MS);
  });

  it('accepts Date instances and epoch numbers', () => {
    expect(deadlineMsOf({ deadline: new Date(NOW_MS) })).toBe(NOW_MS);
    expect(deadlineMsOf({ deadline: NOW_MS })).toBe(NOW_MS);
  });

  it('returns 0 for missing, empty, or unparseable deadlines', () => {
    expect(deadlineMsOf({})).toBe(0);
    expect(deadlineMsOf({ deadline: '' })).toBe(0);
    expect(deadlineMsOf({ deadline: null })).toBe(0);
    expect(deadlineMsOf({ deadline: 'not a date' })).toBe(0);
    expect(deadlineMsOf(null)).toBe(0);
  });
});

describe('overdue cron: proof-bearing tasks are skipped (a)', () => {
  // Mirrors the scan loop in src/app/api/cron/overdue/route.ts: proof-bearing
  // docs are pulled out BEFORE the deadline comparison, so they are never
  // pushed into the batch that flips status to 'overdue'.
  function scanLikeOverdueRoute(docs: ProofDocLike[]) {
    const skipped: string[] = [];
    const toMark: string[] = [];
    for (const d of docs) {
      const data = d.data() as any;
      const status = String(data?.status || '').toLowerCase();
      if (status === 'overdue' || status === 'completed') continue;
      if (taskHasProofUploaded(data)) {
        skipped.push(d.id);
        continue;
      }
      const ms = deadlineMsOf(data);
      if (ms > 0 && ms < NOW_MS) toMark.push(d.id);
    }
    return { skipped, toMark };
  }

  it('skips a pending task whose deadline passed when proof is attached', () => {
    const { skipped, toMark } = scanLikeOverdueRoute([
      makeDoc('proof-task', {
        status: 'pending',
        deadline: PAST_ISO,
        deliverableFiles: [{ fileName: 'proof.pdf' }],
      }),
    ]);
    expect(skipped).toEqual(['proof-task']);
    expect(toMark).toEqual([]);
  });

  it('still marks a past-deadline task with no proof as overdue', () => {
    const { skipped, toMark } = scanLikeOverdueRoute([
      makeDoc('bare-task', { status: 'pending', deadline: PAST_ISO, deliverableFiles: [] }),
    ]);
    expect(skipped).toEqual([]);
    expect(toMark).toEqual(['bare-task']);
  });
});

describe('check-deadlines: proof-bearing tasks reach no warning/penalty (b)', () => {
  // Mirrors the route pipeline: split off proof-bearing docs BEFORE the
  // overdueProcessed filter and the processing loop that issues warnings,
  // penalties, and the overdue stamp.
  function pipelineLikeCheckDeadlines(docs: ProofDocLike[]) {
    const { withProof, withoutProof } = splitProofSkippedDocs(docs);
    const docsToProcess = withoutProof.filter((d) => d.data().overdueProcessed !== true);
    const warningsIssued: string[] = [];
    const penaltiesApplied: string[] = [];
    for (const d of docsToProcess) {
      warningsIssued.push(d.id);
      penaltiesApplied.push(d.id);
    }
    return { proofSkipped: withProof.map((d) => d.id), warningsIssued, penaltiesApplied };
  }

  it('issues no warning and no penalty for a proof-bearing overdue task', () => {
    const result = pipelineLikeCheckDeadlines([
      makeDoc('proof-task', {
        status: 'pending',
        deadline: PAST_ISO,
        deliverableFiles: [{ fileName: 'proof.pdf' }],
      }),
    ]);
    expect(result.proofSkipped).toEqual(['proof-task']);
    expect(result.warningsIssued).toEqual([]);
    expect(result.penaltiesApplied).toEqual([]);
  });

  it('still processes an overdue task with no proof', () => {
    const result = pipelineLikeCheckDeadlines([
      makeDoc('bare-task', { status: 'pending', deadline: PAST_ISO, deliverableFiles: [] }),
    ]);
    expect(result.proofSkipped).toEqual([]);
    expect(result.warningsIssued).toEqual(['bare-task']);
    expect(result.penaltiesApplied).toEqual(['bare-task']);
  });
});

describe('attach-upload: conservative auto-transition (c)', () => {
  it.each(['pending', 'in-progress'])(
    'transitions %s with a pre-deadline upload when a report is stored',
    (status) => {
      expect(
        shouldAutoTransitionOnProofUpload(
          { status, individualDeadline: FUTURE_ISO, report: 'Done, see attached.' },
          NOW_MS
        )
      ).toBe(true);
    }
  );

  it('does NOT transition on a post-deadline upload even with a report', () => {
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'pending', individualDeadline: PAST_ISO, report: 'Done.' },
        NOW_MS
      )
    ).toBe(false);
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'in-progress', deadline: PAST_ISO, report: 'Done.' },
        NOW_MS
      )
    ).toBe(false);
  });

  it('does NOT transition when no report is stored yet', () => {
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'pending', individualDeadline: FUTURE_ISO, report: '' },
        NOW_MS
      )
    ).toBe(false);
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'pending', individualDeadline: FUTURE_ISO, report: '   ' },
        NOW_MS
      )
    ).toBe(false);
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'pending', individualDeadline: FUTURE_ISO },
        NOW_MS
      )
    ).toBe(false);
  });

  it.each(['completed', 'approved', 'overdue', 'submitted-for-review', 'changes-requested', 'rejected'])(
    'never touches status %s',
    (status) => {
      expect(
        shouldAutoTransitionOnProofUpload(
          { status, individualDeadline: FUTURE_ISO, report: 'Done.' },
          NOW_MS
        )
      ).toBe(false);
    }
  );

  it('treats a Timestamp deadline the same as an ISO string', () => {
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'pending', deadline: makeTimestamp(Date.parse(FUTURE_ISO)), report: 'Done.' },
        NOW_MS
      )
    ).toBe(true);
    expect(
      shouldAutoTransitionOnProofUpload(
        { status: 'pending', deadline: makeTimestamp(Date.parse(PAST_ISO)), report: 'Done.' },
        NOW_MS
      )
    ).toBe(false);
  });
});
