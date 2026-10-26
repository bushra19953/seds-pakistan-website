/**
 * Retention engine A8 hook mechanics (cutover): the generic
 * per-doc write hook in RetentionDeps.
 *  - 'handled' verdict: the engine SKIPS its deps.db write and
 *    treats the hook's write as the write (counts still advance).
 *  - hook throw inside the archive step: archiveFailed semantics —
 *    the error is recorded and scrub/delete are blocked, exactly
 *    like a failing deps.db write there.
 *  - 'passthrough': deps.db write commits, then afterDocWrite
 *    runs; an after-hook failure is swallowed (mirror discipline).
 *  - no hooks wired: covered by engine.test.ts (unchanged suite).
 */
import { FakeFirestore } from '../../governance/__tests__/fake-firestore';
import { runRetention, type RetentionDeps, type RetentionDocWrite } from '../engine';

const NOW = new Date('2026-10-21T00:00:00.000Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function seed(db: FakeFirestore) {
  db.seed('applications', 'old-rejected', {
    status: 'rejected',
    createdAt: daysAgo(800),
    fullName: 'Old Applicant',
    email: 'old@example.com',
  });
}

function makeDeps(
  db: FakeFirestore,
  hooks: Partial<RetentionDeps>,
): RetentionDeps {
  return {
    db: db as unknown as RetentionDeps['db'],
    archiveDocs: async () => undefined,
    now: () => NOW,
    ...hooks,
  };
}

describe('retention engine A8 hook', () => {
  it("'handled' verdict: deps.db is never written for the hooked collection; counts still advance", async () => {
    const db = new FakeFirestore();
    seed(db);
    const writes: RetentionDocWrite[] = [];
    const deps = makeDeps(db, {
      onDocWrite: async (w) => {
        writes.push(w);
        return w.collection === 'applications' ? 'handled' : 'passthrough';
      },
    });
    const report = await runRetention(deps);
    const apps = report.classes.find((c) => c.key === 'rejected_applications');
    expect(apps?.archived).toBe(1);
    expect(apps?.scrubbed).toBe(1);
    expect(apps?.errors).toEqual([]);
    // The hook saw the archive stamp AND the PII scrub payloads.
    const updates = writes.filter((w) => w.kind === 'update');
    expect(updates.some((w) => w.data?.retentionArchivedAt)).toBe(true);
    expect(
      updates.some(
        (w) => w.data?.retentionScrubbedAt && w.data?.fullName === null,
      ),
    ).toBe(true);
    // deps.db doc is untouched — the hook's store is the only writer.
    const doc = db.getDoc('applications', 'old-rejected');
    expect(doc?.fullName).toBe('Old Applicant');
    expect(doc?.retentionArchivedAt).toBeUndefined();
    expect(
      db.updateCalls.filter((u) => u.collection === 'applications'),
    ).toHaveLength(0);
  });

  it('hook throw in the archive step blocks scrub and records the error (primary-failure parity)', async () => {
    const db = new FakeFirestore();
    seed(db);
    const deps = makeDeps(db, {
      onDocWrite: async () => {
        throw new Error('primary write failed: unreconciled row');
      },
    });
    const report = await runRetention(deps);
    const apps = report.classes.find((c) => c.key === 'rejected_applications');
    expect(apps?.archived).toBe(0);
    expect(apps?.scrubbed).toBe(0);
    expect(apps?.errors.some((e) => e.includes('primary write failed'))).toBe(
      true,
    );
    expect(db.getDoc('applications', 'old-rejected')?.fullName).toBe(
      'Old Applicant',
    );
  });

  it("'passthrough': deps.db write commits, afterDocWrite runs after it, and its failure is swallowed", async () => {
    const db = new FakeFirestore();
    seed(db);
    const after: RetentionDocWrite[] = [];
    const deps = makeDeps(db, {
      onDocWrite: async () => 'passthrough',
      afterDocWrite: async (w) => {
        after.push(w);
        throw new Error('mirror down');
      },
    });
    const report = await runRetention(deps);
    const apps = report.classes.find((c) => c.key === 'rejected_applications');
    expect(apps?.errors).toEqual([]);
    expect(apps?.scrubbed).toBe(1);
    // The deps.db write landed despite the after-hook throwing.
    expect(db.getDoc('applications', 'old-rejected')?.fullName).toBeNull();
    expect(after.length).toBeGreaterThanOrEqual(2);
  });
});
