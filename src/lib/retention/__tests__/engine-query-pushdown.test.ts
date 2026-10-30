/**
 * Cron shelter (census 20 row 3): retention predicate pushdown.
 *
 * Pins:
 *  - the query the engine issues carries the policy's date predicate
 *    (where(dateField, '<', cutoff)) — recorded verbatim by the fake;
 *  - the cutoff is the policy's SMALLEST threshold (the earliest
 *    instant any action can touch);
 *  - results are UNCHANGED vs the pre-shelter full scan: same
 *    archived / scrubbed / deleted / flagged counts and same final
 *    document states, on the same fixture, run both ways;
 *  - the in-memory double-check drops rows a tolerant store returns
 *    despite the predicate (a too-fresh row handed back by the query
 *    is counted in `scanned` nowhere and acted on never);
 *  - pagination walks startAfter pages until a short page.
 * Zero live reads/writes.
 */
import {
  runRetention,
  retentionCutoff,
  type RetentionDeps,
  type RetentionPolicy,
} from '../engine';

const NOW = new Date('2026-10-21T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * DAY_MS).toISOString();

type DocSeed = { id: string; data: Record<string, unknown> };

interface RecordedQuery {
  collection: string;
  wheres: Array<{ field: string; op: string; value: unknown }>;
  limits: number[];
  pages: number;
}

function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'number') return v;
  return null;
}

/**
 * An honest fake: where() really filters (date-aware '<'), orderBy
 * sorts, limit/startAfter really page. `lieAboutPredicate` makes the
 * where() a no-op filter (a tolerant store) while still recording it.
 */
function makeDb(
  seed: Record<string, DocSeed[]>,
  opts: { lieAboutPredicate?: boolean; pageCap?: number } = {},
) {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [col, docs] of Object.entries(seed)) {
    store.set(col, new Map(docs.map((d) => [d.id, { ...d.data }])));
  }
  const queries: RecordedQuery[] = [];
  const updates: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const deletes: Array<{ collection: string; id: string }> = [];

  const snapOf = (col: string, docs: DocSeed[]) => ({
    docs: docs.map((d) => ({
      id: d.id,
      ref: { col, id: d.id },
      data: () => ({ ...d.data }),
    })),
    empty: docs.length === 0,
    size: docs.length,
  });

  function makeQuery(
    col: string,
    wheres: RecordedQuery['wheres'],
    orderField: string | null,
    limitN: number | null,
    afterId: string | null,
    record: RecordedQuery,
  ): Record<string, unknown> {
    return {
      where: (field: string, op: string, value: unknown) =>
        makeQuery(col, [...wheres, { field, op, value }], orderField, limitN, afterId, record),
      orderBy: (field: string) =>
        makeQuery(col, wheres, field, limitN, afterId, record),
      limit: (n: number) => {
        record.limits.push(n);
        return makeQuery(col, wheres, orderField, n, afterId, record);
      },
      startAfter: (doc: { id: string }) =>
        makeQuery(col, wheres, orderField, limitN, doc.id, record),
      count: () => ({
        get: async () => {
          let docs: DocSeed[] = [...(store.get(col)?.entries() ?? [])].map(
            ([id, data]) => ({ id, data }),
          );
          if (!opts.lieAboutPredicate) {
            docs = docs.filter((d) =>
              wheres.every(({ field, op, value }) => {
                if (op === '==') return d.data[field] === value;
                return true;
              }),
            );
          }
          return { data: () => ({ count: docs.length }) };
        },
      }),
      get: async () => {
        record.pages += 1;
        let docs: DocSeed[] = [...(store.get(col)?.entries() ?? [])].map(
          ([id, data]) => ({ id, data }),
        );
        if (!opts.lieAboutPredicate) {
          docs = docs.filter((d) =>
            wheres.every(({ field, op, value }) => {
              const a = toMs(d.data[field]);
              const b = toMs(value);
              if (op === '<' && a !== null && b !== null) return a < b;
              if (op === '==') return d.data[field] === value;
              return true;
            }),
          );
        }
        if (orderField) {
          docs.sort((x, y) => (toMs(x.data[orderField]) ?? 0) - (toMs(y.data[orderField]) ?? 0));
        }
        if (afterId) {
          const idx = docs.findIndex((d) => d.id === afterId);
          docs = docs.slice(idx + 1);
        }
        const cap = Math.min(limitN ?? Infinity, opts.pageCap ?? Infinity);
        return snapOf(col, docs.slice(0, cap));
      },
    };
  }

  const db = {
    collection: (name: string) => ({
      get: async () =>
        snapOf(
          name,
          [...(store.get(name)?.entries() ?? [])].map(([id, data]) => ({ id, data })),
        ),
      where: (field: string, op: string, value: unknown) => {
        const record: RecordedQuery = {
          collection: name,
          wheres: [{ field, op, value }],
          limits: [],
          pages: 0,
        };
        queries.push(record);
        return makeQuery(name, record.wheres, null, null, null, record);
      },
      count: () => ({
        get: async () => ({
          data: () => ({ count: store.get(name)?.size ?? 0 }),
        }),
      }),
      doc: (id: string) => ({
        update: async (data: Record<string, unknown>) => {
          updates.push({ collection: name, id, data });
          const colMap = store.get(name);
          if (colMap?.has(id)) colMap.set(id, { ...colMap.get(id), ...data });
        },
        delete: async () => {
          deletes.push({ collection: name, id });
          store.get(name)?.delete(id);
        },
      }),
    }),
  };
  return { db, queries, updates, deletes, store };
}

function makeDeps(
  db: ReturnType<typeof makeDb>['db'],
  archived: Array<{ collection: string; ids: string[] }>,
): RetentionDeps {
  return {
    db: db as unknown as RetentionDeps['db'],
    archiveDocs: async (collection, docs) => {
      archived.push({ collection, ids: docs.map((d) => d.id) });
    },
    now: () => NOW,
  };
}

const SEED: Record<string, DocSeed[]> = {
  applications: [
    { id: 'old-rejected', data: { status: 'rejected', createdAt: daysAgo(800), fullName: 'Old', email: 'o@x' } },
    { id: 'fresh-rejected', data: { status: 'rejected', createdAt: daysAgo(30), fullName: 'Fresh', email: 'f@x' } },
    { id: 'old-pending', data: { status: 'pending', createdAt: daysAgo(900), fullName: 'Pend', email: 'p@x' } },
  ],
  audit_logs: [
    { id: 'mid-audit', data: { timestamp: daysAgo(800), type: 'X' } },
    { id: 'ancient-audit', data: { timestamp: daysAgo(3700), type: 'Y', retentionArchivedAt: daysAgo(100) } },
    { id: 'fresh-audit', data: { timestamp: daysAgo(10), type: 'Z' } },
  ],
  governance_records: [
    { id: 'gov-1', data: { createdAt: daysAgo(4000), title: 'Constitution' } },
  ],
};

const POLICIES: RetentionPolicy[] = [
  {
    key: 'rejected_applications', collection: 'applications', dateField: 'createdAt',
    scope: 'status == rejected', archiveAfterDays: 730, scrubAfterDays: 730,
    deleteAfterDays: null, flagForReviewOnly: false, notes: '',
  },
  {
    key: 'audit_logs', collection: 'audit_logs', dateField: 'timestamp',
    scope: 'all', archiveAfterDays: 730, scrubAfterDays: null,
    deleteAfterDays: 3650, flagForReviewOnly: false, notes: '',
  },
  {
    key: 'governance_records', collection: 'governance_records', dateField: 'createdAt',
    scope: 'all', archiveAfterDays: null, scrubAfterDays: null,
    deleteAfterDays: null, flagForReviewOnly: true, notes: '',
  },
];

describe('retentionCutoff', () => {
  it('is the smallest non-null threshold; null when a policy has no action', () => {
    expect(retentionCutoff(POLICIES[1], NOW.getTime())!.getTime()).toBe(
      NOW.getTime() - 730 * DAY_MS,
    );
    expect(retentionCutoff(POLICIES[2], NOW.getTime())).toBeNull();
  });
});

describe('runRetention with predicate pushdown', () => {
  it('issues where(dateField, "<", cutoff) per actionable policy and no where for flag-only', async () => {
    const { db, queries } = makeDb(SEED);
    const archived: Array<{ collection: string; ids: string[] }> = [];
    await runRetention(makeDeps(db, archived), POLICIES);

    const appsQ = queries.find((q) => q.collection === 'applications');
    expect(appsQ).toBeDefined();
    expect(appsQ!.wheres).toEqual([
      { field: 'createdAt', op: '<', value: new Date(NOW.getTime() - 730 * DAY_MS) },
    ]);
    const auditQ = queries.find((q) => q.collection === 'audit_logs');
    expect(auditQ!.wheres).toEqual([
      { field: 'timestamp', op: '<', value: new Date(NOW.getTime() - 730 * DAY_MS) },
    ]);
    expect(queries.some((q) => q.collection === 'governance_records')).toBe(false);
  });

  it('results are unchanged vs the pre-shelter full scan on the same fixture', async () => {
    // Pushed-down run.
    const pushed = makeDb(SEED);
    const pushedArchived: Array<{ collection: string; ids: string[] }> = [];
    const pushedReport = await runRetention(makeDeps(pushed.db, pushedArchived), POLICIES);

    // Legacy run: a db with NO where surface takes the engine's
    // single-get fallback — the pre-shelter read path.
    const legacy = makeDb(SEED);
    const legacyDb = {
      collection: (name: string) => {
        const col = legacy.db.collection(name);
        return { get: col.get, doc: col.doc };
      },
    };
    const legacyArchived: Array<{ collection: string; ids: string[] }> = [];
    const legacyReport = await runRetention(
      makeDeps(legacyDb as never, legacyArchived),
      POLICIES,
    );

    const counts = (r: typeof pushedReport) =>
      r.classes.map((c) => ({
        key: c.key,
        archived: c.archived,
        scrubbed: c.scrubbed,
        deleted: c.deleted,
        flaggedForReview: c.flaggedForReview,
        errors: c.errors,
      }));
    expect(counts(pushedReport)).toEqual(counts(legacyReport));
    expect(pushedArchived).toEqual(legacyArchived);
    // Final stored state identical across both read paths.
    for (const col of Object.keys(SEED)) {
      const a = [...(pushed.store.get(col)?.entries() ?? [])].sort();
      const b = [...(legacy.store.get(col)?.entries() ?? [])].sort();
      expect(a).toEqual(b);
    }
    // And the outcomes are the known-good ones, not just mutually equal.
    const apps = pushedReport.classes.find((c) => c.key === 'rejected_applications');
    expect(apps).toMatchObject({ archived: 1, scrubbed: 1, deleted: 0 });
    // `scanned` keeps its pre-shelter meaning (whole in-scope class)
    // via the count() probe: 2 rejected applications, 3 audit logs —
    // even though the pushed-down scan only FETCHED the stale rows.
    expect(apps!.scanned).toBe(2);
    expect(
      pushedReport.classes.find((c) => c.key === 'audit_logs')!.scanned,
    ).toBe(3);
    const audit = pushedReport.classes.find((c) => c.key === 'audit_logs');
    expect(audit).toMatchObject({ archived: 1, deleted: 1 });
    const gov = pushedReport.classes.find((c) => c.key === 'governance_records');
    expect(gov).toMatchObject({ flaggedForReview: 1 });
    expect(pushed.store.get('applications')!.get('old-rejected')!.fullName).toBeNull();
    expect(pushed.store.get('applications')!.get('fresh-rejected')!.fullName).toBe('Fresh');
  });

  it('double-check: a tolerant store returning a too-fresh row cannot get it acted on', async () => {
    const lying = makeDb(SEED, { lieAboutPredicate: true });
    const archived: Array<{ collection: string; ids: string[] }> = [];
    const report = await runRetention(makeDeps(lying.db, archived), POLICIES);
    // The query still carried the predicate (that is the read saving);
    // the fresh rows the store handed back anyway were filtered by
    // the in-memory double-check before any step saw them.
    expect(lying.queries.length).toBeGreaterThan(0);
    const apps = report.classes.find((c) => c.key === 'rejected_applications');
    expect(apps).toMatchObject({ archived: 1, scrubbed: 1 });
    expect(lying.store.get('applications')!.get('fresh-rejected')!.fullName).toBe('Fresh');
    expect(archived.flatMap((a) => a.ids)).not.toContain('fresh-rejected');
    expect(archived.flatMap((a) => a.ids)).not.toContain('fresh-audit');
  });

  it('paginates: walks pages of RETENTION_PAGE_SIZE until a short page', async () => {
    const many: DocSeed[] = Array.from({ length: 450 }, (_, i) => ({
      id: `a-${String(i).padStart(3, '0')}`,
      data: { timestamp: daysAgo(800 + i), type: 'X' },
    }));
    const { db, queries } = makeDb({ audit_logs: many });
    const archived: Array<{ collection: string; ids: string[] }> = [];
    const report = await runRetention(makeDeps(db, archived), [POLICIES[1]]);
    const q = queries.find((x) => x.collection === 'audit_logs')!;
    expect(q.pages).toBe(3); // 200 + 200 + 50
    expect(q.limits.every((n) => n === 200)).toBe(true);
    const audit = report.classes[0];
    expect(audit.archived).toBe(450);
    expect(archived[0].ids).toHaveLength(450);
  });
});
