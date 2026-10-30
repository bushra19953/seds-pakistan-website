/**
 * Cron shelter (census 20 row 1): backup incremental mode.
 *
 * Pins the skip decision end to end:
 *  - planBackupCollections is pure: skip ONLY on prior state + a live
 *    count() probe that matches it exactly; missing state, missing
 *    probe (null) and count mismatch all export;
 *  - runBackup in incremental mode uploads nothing for an unchanged
 *    collection, exports a changed one, carries the state chain
 *    forward in the backup_runs record it writes, and reports the
 *    skips on both the record and the manifest;
 *  - 'auto' resolves to incremental inside the full-anchor week and
 *    to full once the anchor is stale; an explicit incremental run
 *    with no prior state is a full run;
 *  - a collection whose export fails keeps its PRIOR state (the last
 *    successful export), never a fresh one.
 * No test touches real Firestore or Drive.
 */
import {
  planBackupCollections,
  resolveBackupMode,
  runBackup,
  FULL_ANCHOR_INTERVAL_MS,
  type BackupDeps,
  type BackupPriorRun,
  type BackupRunRecord,
} from '../engine';
import type { BackupCollectionEntry } from '../registry';

const entry = (name: string): BackupCollectionEntry => ({
  name,
  backupClass: 'full',
});

describe('planBackupCollections (pure skip decision)', () => {
  const entries = [entry('users'), entry('blogs'), entry('events')];
  const prior = {
    users: { count: 2, sha256: 'a', exportedAt: '2026-10-20T00:00:00.000Z' },
    blogs: { count: 1, sha256: 'b', exportedAt: '2026-10-20T00:00:00.000Z' },
    // events: no prior state
  };

  it('skips only on exact count match with prior state', () => {
    const probes = new Map<string, number | null>([
      ['users', 2], // unchanged -> skip
      ['blogs', 5], // count moved -> export
      ['events', 0], // no prior state -> export even at 0
    ]);
    const plan = planBackupCollections(entries, prior, probes);
    expect(plan.skipped).toEqual(['users']);
    expect(plan.exportEntries.map((e) => e.name)).toEqual(['blogs', 'events']);
  });

  it('a failed/absent probe (null) never skips', () => {
    const probes = new Map<string, number | null>([
      ['users', null],
      ['blogs', null],
      ['events', null],
    ]);
    const plan = planBackupCollections(entries, prior, probes);
    expect(plan.skipped).toEqual([]);
    expect(plan.exportEntries).toHaveLength(3);
  });

  it('no prior states at all exports everything', () => {
    const probes = new Map<string, number | null>([['users', 2]]);
    const plan = planBackupCollections(entries, null, probes);
    expect(plan.skipped).toEqual([]);
    expect(plan.exportEntries).toHaveLength(3);
  });
});

describe('resolveBackupMode', () => {
  const nowMs = Date.parse('2026-10-21T00:00:00.000Z');
  const priorWithAnchor = (anchorIso: string): BackupPriorRun => ({
    status: 'success',
    finishedAt: anchorIso,
    anchorFinishedAt: anchorIso,
    collectionStates: {},
  });

  it('auto: fresh anchor -> incremental; stale anchor -> full', () => {
    const fresh = new Date(nowMs - FULL_ANCHOR_INTERVAL_MS + 1000).toISOString();
    const stale = new Date(nowMs - FULL_ANCHOR_INTERVAL_MS - 1000).toISOString();
    expect(resolveBackupMode('auto', priorWithAnchor(fresh), nowMs)).toBe('incremental');
    expect(resolveBackupMode('auto', priorWithAnchor(stale), nowMs)).toBe('full');
  });

  it('auto: no prior run or no states -> full', () => {
    expect(resolveBackupMode('auto', null, nowMs)).toBe('full');
    expect(
      resolveBackupMode('auto', { status: 'success', finishedAt: 'x' }, nowMs),
    ).toBe('full');
  });

  it('explicit incremental without prior states degrades to full; full stays full', () => {
    expect(resolveBackupMode('incremental', null, nowMs)).toBe('full');
    expect(
      resolveBackupMode('incremental', priorWithAnchor(new Date(nowMs).toISOString()), nowMs),
    ).toBe('incremental');
    expect(resolveBackupMode('full', priorWithAnchor(new Date(nowMs).toISOString()), nowMs)).toBe('full');
  });
});

// --- runBackup integration over a fake db with count() probes --------

const T0 = new Date('2026-10-21T00:00:00.000Z');
const ANCHOR = '2026-10-20T00:00:00.000Z';

function makeIncrementalDeps(opts: {
  data: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
  prior: BackupPriorRun | null;
  countOverrides?: Record<string, number | null>;
  failing?: string[];
}) {
  const uploads: string[] = [];
  const gets: string[] = [];
  const runRecords: BackupRunRecord[] = [];
  const deps: BackupDeps = {
    db: {
      collection: (name: string) => ({
        get: async () => {
          gets.push(name);
          if ((opts.failing ?? []).includes(name)) throw new Error(`boom: ${name}`);
          return {
            docs: (opts.data[name] ?? []).map((d) => ({
              id: d.id,
              data: () => d.data,
            })),
          };
        },
        count: () => ({
          get: async () => {
            const override = opts.countOverrides?.[name];
            return {
              data: () => ({
                count:
                  override === undefined
                    ? (opts.data[name] ?? []).length
                    : (override as number),
              }),
            };
          },
        }),
      }),
    },
    uploadToDrive: async (args) => {
      uploads.push(args.fileName);
      return { fileId: `drive-${uploads.length}` };
    },
    writeRunRecord: async (_runId, record) => {
      runRecords.push(record);
    },
    writeAudit: async () => undefined,
    loadLastRun: async () => opts.prior,
    resolveFolderId: async () => 'backups-folder-1',
    now: () => T0,
    runIdFactory: () => 'backup_incr_run',
  };
  return { deps, uploads, gets, runRecords };
}

const PRIOR: BackupPriorRun = {
  status: 'success',
  finishedAt: ANCHOR,
  anchorFinishedAt: ANCHOR,
  collectionStates: {
    users: { count: 2, sha256: 'old-users-sha', exportedAt: ANCHOR },
    blogs: { count: 1, sha256: 'old-blogs-sha', exportedAt: ANCHOR },
  },
};

describe('runBackup incremental mode', () => {
  it('skips the unchanged collection (no get, no upload), exports the changed one, chains state', async () => {
    const { deps, uploads, gets, runRecords } = makeIncrementalDeps({
      data: {
        users: [
          { id: 'u1', data: { name: 'A' } },
          { id: 'u2', data: { name: 'B' } },
        ],
        blogs: [
          { id: 'b1', data: { title: 'One' } },
          { id: 'b2', data: { title: 'Two' } }, // grew 1 -> 2
        ],
      },
      prior: PRIOR,
    });
    const result = await runBackup(deps, {
      collections: ['users', 'blogs'],
      mode: 'incremental',
    });

    expect(result.status).toBe('success');
    expect(result.mode).toBe('incremental');
    expect(result.skippedCollections).toEqual(['users']);
    // The skipped collection was never document-read and never uploaded.
    expect(gets).toEqual(['blogs']);
    expect(uploads.some((f) => f.includes('__users.json'))).toBe(false);
    expect(uploads.some((f) => f.includes('__blogs.json'))).toBe(true);
    expect(result.manifest!.collections.map((c) => c.name)).toEqual(['blogs']);
    expect(result.manifest!.skippedCollections).toEqual(['users']);
    expect(result.totals.documents).toBe(2);

    // The written record carries the chain: users state carried
    // forward untouched, blogs state refreshed, anchor preserved.
    expect(runRecords).toHaveLength(1);
    const record = runRecords[0];
    expect(record.mode).toBe('incremental');
    expect(record.anchorFinishedAt).toBe(ANCHOR);
    expect(record.collectionStates!.users).toEqual(PRIOR.collectionStates!.users);
    expect(record.collectionStates!.blogs.count).toBe(2);
    expect(record.collectionStates!.blogs.sha256).not.toBe('old-blogs-sha');
    expect(record.collectionStates!.blogs.exportedAt).toBe(T0.toISOString());
  });

  it('auto mode inside the anchor week runs incremental; explicit full ignores prior state', async () => {
    const data = {
      users: [
        { id: 'u1', data: {} },
        { id: 'u2', data: {} },
      ],
    };
    const auto = makeIncrementalDeps({ data, prior: PRIOR });
    const autoResult = await runBackup(auto.deps, {
      collections: ['users'],
      mode: 'auto',
    });
    expect(autoResult.mode).toBe('incremental');
    expect(autoResult.skippedCollections).toEqual(['users']);

    const full = makeIncrementalDeps({ data, prior: PRIOR });
    const fullResult = await runBackup(full.deps, {
      collections: ['users'],
      mode: 'full',
    });
    expect(fullResult.mode).toBe('full');
    expect(fullResult.skippedCollections).toEqual([]);
    expect(fullResult.totals.documents).toBe(2);
    // A full run re-anchors at its own finish.
    expect(full.runRecords[0].anchorFinishedAt).toBe(T0.toISOString());
  });

  it('a failed export keeps the prior state, so the chain still points at the last success', async () => {
    const { deps, runRecords } = makeIncrementalDeps({
      data: {
        users: [
          { id: 'u1', data: {} },
          { id: 'u2', data: {} },
          { id: 'u3', data: {} }, // count moved 2 -> 3: export attempted
        ],
      },
      prior: PRIOR,
      failing: ['users'],
    });
    const result = await runBackup(deps, {
      collections: ['users'],
      mode: 'incremental',
    });
    expect(result.status).toBe('partial');
    expect(result.skippedCollections).toEqual([]);
    expect(runRecords[0].collectionStates!.users).toEqual(
      PRIOR.collectionStates!.users,
    );
  });

  it('without a count() surface nothing is skipped (fail-safe to export)', async () => {
    const { deps } = makeIncrementalDeps({
      data: { users: [{ id: 'u1', data: {} }, { id: 'u2', data: {} }] },
      prior: PRIOR,
    });
    // Strip the probe: a plain get()-only db, like the engine's
    // original contract and the legacy test fakes.
    deps.db = {
      collection: (name: string) => ({
        get: async () => ({
          docs: [{ id: 'u1', data: () => ({}) }, { id: 'u2', data: () => ({}) }],
        }),
      }),
    };
    const result = await runBackup(deps, {
      collections: ['users'],
      mode: 'incremental',
    });
    expect(result.skippedCollections).toEqual([]);
    expect(result.totals.documents).toBe(2);
  });
});
