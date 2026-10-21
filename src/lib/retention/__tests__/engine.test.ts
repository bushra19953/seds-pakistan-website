/**
 * Retention engine tests (Workstream F) on an in-memory fake:
 * rejected applications archive+scrub at 24 months (F-G2), audit logs
 * archive at 2y / delete at 10y only with an archive copy (F-G3),
 * governance classes are never modified (flag-for-review only).
 */
import { FakeFirestore } from '../../governance/__tests__/fake-firestore';
import { runRetention, type RetentionDeps } from '../engine';

const NOW = new Date('2026-10-21T00:00:00.000Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function makeDeps(db: FakeFirestore, failArchive = false) {
  const archived: Array<{ collection: string; ids: string[] }> = [];
  const deps: RetentionDeps = {
    db: db as unknown as RetentionDeps['db'],
    archiveDocs: async (collection, docs) => {
      if (failArchive) throw new Error('drive unavailable');
      archived.push({ collection, ids: docs.map((d) => d.id) });
    },
    now: () => NOW,
  };
  return { deps, archived };
}

function seedAll(db: FakeFirestore) {
  db.seed('applications', 'old-rejected', {
    status: 'rejected',
    createdAt: daysAgo(800),
    fullName: 'Old Applicant',
    email: 'old@example.com',
  });
  db.seed('applications', 'fresh-rejected', {
    status: 'rejected',
    createdAt: daysAgo(30),
    fullName: 'Fresh Applicant',
    email: 'fresh@example.com',
  });
  db.seed('applications', 'old-pending', {
    status: 'pending',
    createdAt: daysAgo(900),
    fullName: 'Pending Person',
    email: 'pending@example.com',
  });
  db.seed('audit_logs', 'mid-audit', { timestamp: daysAgo(800), type: 'X' });
  db.seed('audit_logs', 'ancient-audit', {
    timestamp: daysAgo(3700),
    type: 'Y',
    retentionArchivedAt: daysAgo(100),
  });
  db.seed('governance_records', 'gov-1', {
    createdAt: daysAgo(4000),
    title: 'Constitution',
  });
}

describe('retention engine', () => {
  it('archives and scrubs old rejected applications, leaves fresh and pending ones alone', async () => {
    const db = new FakeFirestore();
    seedAll(db);
    const { deps, archived } = makeDeps(db);
    const report = await runRetention(deps);
    const apps = report.classes.find((c) => c.key === 'rejected_applications');
    expect(apps?.archived).toBe(1);
    expect(apps?.scrubbed).toBe(1);
    expect(archived.some((a) => a.collection === 'applications' && a.ids.includes('old-rejected'))).toBe(true);
    const scrubbed = db.getDoc('applications', 'old-rejected');
    expect(scrubbed?.fullName).toBeNull();
    expect(scrubbed?.email).toBeNull();
    expect(scrubbed?.status).toBe('rejected');
    expect(scrubbed?.retentionScrubbedAt).toBeTruthy();
    expect(db.getDoc('applications', 'fresh-rejected')?.fullName).toBe('Fresh Applicant');
    expect(db.getDoc('applications', 'old-pending')?.fullName).toBe('Pending Person');
  });

  it('archives mid-age audit logs and deletes only already-archived ancient ones', async () => {
    const db = new FakeFirestore();
    seedAll(db);
    const { deps } = makeDeps(db);
    const report = await runRetention(deps);
    const audit = report.classes.find((c) => c.key === 'audit_logs');
    expect(audit?.archived).toBe(1); // mid-audit newly archived
    expect(audit?.deleted).toBe(1); // ancient-audit (already archived)
    expect(db.getDoc('audit_logs', 'mid-audit')).toBeTruthy();
    expect(db.getDoc('audit_logs', 'ancient-audit')).toBeUndefined();
  });

  it('never modifies governance classes, only flags them for review', async () => {
    const db = new FakeFirestore();
    seedAll(db);
    const { deps } = makeDeps(db);
    const updatesBefore = db.updateCalls.length;
    const report = await runRetention(deps);
    const gov = report.classes.find((c) => c.key === 'governance_records');
    expect(gov?.flaggedForReview).toBe(1);
    expect(gov?.deleted).toBe(0);
    expect(db.getDoc('governance_records', 'gov-1')?.title).toBe('Constitution');
    expect(
      db.updateCalls.filter((u) => u.collection === 'governance_records'),
    ).toHaveLength(0);
    expect(updatesBefore).toBe(0);
  });

  it('blocks scrub and delete when the archive step fails', async () => {
    const db = new FakeFirestore();
    seedAll(db);
    const { deps } = makeDeps(db, true);
    const report = await runRetention(deps);
    const apps = report.classes.find((c) => c.key === 'rejected_applications');
    expect(apps?.scrubbed).toBe(0);
    expect(apps?.errors.length).toBeGreaterThan(0);
    expect(db.getDoc('applications', 'old-rejected')?.fullName).toBe('Old Applicant');
  });
});
