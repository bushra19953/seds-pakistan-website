/**
 * @jest-environment node
 *
 * admin-dashboard-supa.test.ts — parity tests for the admin-1 dashboard
 * init seam (src/lib/server/admin-dashboard-supa.ts), driven against the
 * admin-6 harness fixtures (./admin-parity-fixtures.ts, copied verbatim
 * from src/lib/supa/__tests__/admin-parity-fixtures.ts on the admin-6
 * branch) and its PARITY_TABLE.md section 1 values. Fixed clock:
 * NOW = 2026-10-25T12:00:00.000Z. Zero live reads: the seam runs against
 * an in-memory fake adapter implementing adapter-faithful semantics:
 *  - rows are { id, data: jsonb } (fixtures pass through toJsonb first),
 *  - equality filters compare data->>'field' TEXT extraction,
 *  - listDocs orderBy on a data field is finished client-side the way
 *    the real adapter finishes it (timestamps chronologically, numbers
 *    numerically, strings as text, document-id-ascending tiebreak, and
 *    documents missing the ordered field are excluded),
 *  - returned docs are flattened { id, ...data } (SupaDoc shape).
 */

import {
  NOW_MS,
  DAY_MS,
  ts,
  toJsonb,
  toJsonbAll,
  type FDoc,
  DASH_USERS,
  DASH_PROJECTS,
  DASH_BLOGS,
  DASH_EVENTS,
  DASH_ANNOUNCEMENTS,
  DASH_APPLICATIONS,
  DASH_TASKS,
  DASH_AUDIT,
  DASH_AUDIT_STRING_TS,
  pendingApps,
  PENDING_CAP_105,
} from './admin-parity-fixtures';
import {
  getAdminDashboardInitFromSupa,
  tryAdminDashboardInitFromSupa,
  setAdminDashboardSupaAdapterForTests,
  supaTimestampMillis,
  type AdminDashboardSupaAdapter,
  type AdminDashboardWhereClause,
} from '@/lib/server/admin-dashboard-supa';

/* --------------------------------------------------------- fake adapter */

const textOf = (v: any): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

function compareFinished(a: any, b: any): number {
  // Adapter client-side finishing value comparison for these fixtures:
  // timestamp-shaped values chronologically, numbers numerically,
  // everything else as text.
  const ma = supaTimestampMillis(a);
  const mb = supaTimestampMillis(b);
  if (ma !== null && mb !== null && (typeof a !== 'number' || typeof b !== 'number')) {
    // ISO/date strings only: bare numbers compare numerically below.
    if (typeof a === 'string' || typeof b === 'string' || typeof a === 'object' || typeof b === 'object') {
      return ma - mb;
    }
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const ta = textOf(a);
  const tb = textOf(b);
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

class FakeSupaAdapter implements AdminDashboardSupaAdapter {
  calls = 0;
  constructor(private store: Record<string, FDoc[]>) {}

  private matching(collection: string, where: AdminDashboardWhereClause[] = []): FDoc[] {
    const rows = this.store[collection] ?? [];
    return rows.filter((r) =>
      where.every(([f, _op, v]) => textOf(r.data[f]) === textOf(v)),
    );
  }

  async countDocs(collection: string, where: AdminDashboardWhereClause[] = []): Promise<number> {
    this.calls++;
    return this.matching(collection, where).length;
  }

  async listDocs(
    collection: string,
    options: {
      where?: AdminDashboardWhereClause[];
      orderBy?: any;
      limit?: number;
    } = {},
  ): Promise<Array<{ id: string } & Record<string, unknown>>> {
    this.calls++;
    let rows = this.matching(collection, options.where);
    const orders = !options.orderBy
      ? []
      : (Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]).map((o: any) =>
          typeof o === 'string' ? { field: o, direction: 'asc' } : o,
        );
    // G4: orderBy on a data field excludes docs missing that field.
    for (const o of orders) {
      if (o.field !== 'id' && o.field !== '__name__') {
        rows = rows.filter((r) => r.data[o.field] !== undefined);
      }
    }
    if (orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const o of orders) {
          const c =
            o.field === 'id' || o.field === '__name__'
              ? a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0
              : compareFinished(a.data[o.field], b.data[o.field]);
          if (c !== 0) return o.direction === 'desc' ? -c : c;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id-asc tiebreak
      });
    }
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map((r) => ({ id: r.id, ...r.data }));
  }
}

function dashStore(overrides: Record<string, FDoc[]> = {}): Record<string, FDoc[]> {
  return {
    users: toJsonbAll(DASH_USERS),
    projects: toJsonbAll(DASH_PROJECTS),
    blogs: toJsonbAll(DASH_BLOGS),
    events: toJsonbAll(DASH_EVENTS),
    announcements: toJsonbAll(DASH_ANNOUNCEMENTS),
    applications: toJsonbAll(DASH_APPLICATIONS),
    tasks: toJsonbAll(DASH_TASKS),
    audit_logs: toJsonbAll(DASH_AUDIT),
    ...overrides,
  };
}

const run = (store: Record<string, FDoc[]>, chapterId: string | null = null) =>
  getAdminDashboardInitFromSupa(new FakeSupaAdapter(store), { chapterId, nowMs: NOW_MS });

/* ------------------------------------------------------------------ tests */

describe('dashboard init seam — global scope (PARITY_TABLE section 1)', () => {
  it('global metrics + indicators parity', async () => {
    const payload = await run(dashStore());
    expect(payload.metrics).toEqual({
      users: 6,
      projects: 3,
      blogs: 2,
      events: 3,
      announcements: 2,
      applicationsPending: 5,
      applicationsShortlisted: 2,
      applicationsRejected: 1,
    });
    expect(payload.indicators).toEqual({
      usersDeparted: 1,
      medianDaysWaiting: 20.0,
      tasksCompleted: 3,
      tasksOverdueRate: 22.2,
    });
  });

  it('chapter scope ch-a: full metrics + indicators parity', async () => {
    const payload = await run(dashStore(), 'ch-a');
    expect(payload.metrics).toEqual({
      users: 3,
      projects: 2,
      blogs: 1,
      events: 1,
      announcements: 2,
      applicationsPending: 3,
      applicationsShortlisted: 1,
      applicationsRejected: 1,
    });
    expect(payload.indicators).toEqual({
      usersDeparted: 0,
      medianDaysWaiting: 25.0,
      tasksCompleted: 2,
      tasksOverdueRate: 20.0,
    });
    // Chapter-scoped audit: all DASH_AUDIT docs are ch-a, still latest 20.
    expect(payload.auditLogs).toHaveLength(20);
  });
});

describe('dashboard pending median edges', () => {
  const medianOf = async (apps: FDoc[]) => {
    const payload = await run(dashStore({ applications: toJsonbAll(apps), tasks: [], audit_logs: [] }));
    return {
      count: payload.metrics.applicationsPending,
      medianDaysWaiting: payload.indicators.medianDaysWaiting,
    };
  };

  it('median odd count (ages 10,20,30)', async () => {
    await expect(medianOf(pendingApps([10, 20, 30]))).resolves.toEqual({
      count: 3,
      medianDaysWaiting: 20.0,
    });
  });

  it('median even count (ages 10,20,30,40)', async () => {
    await expect(medianOf(pendingApps([10, 20, 30, 40]))).resolves.toEqual({
      count: 4,
      medianDaysWaiting: 25.0,
    });
  });

  it('median rounding to 0.1 (raw 2.25 -> 2.3)', async () => {
    await expect(medianOf(pendingApps([2.25]))).resolves.toEqual({
      count: 1,
      medianDaysWaiting: 2.3,
    });
  });

  it('median null when no pending doc has a timestamp; count still exact', async () => {
    await expect(medianOf(pendingApps([null, null]))).resolves.toEqual({
      count: 2,
      medianDaysWaiting: null,
    });
  });

  it('median sample capped at id-ordered 100; count exact at 105', async () => {
    await expect(medianOf(PENDING_CAP_105)).resolves.toEqual({
      count: 105,
      medianDaysWaiting: 49.5,
    });
  });

  it('created_at takes precedence; null created_at falls back to createdAt; future clamps to 0', async () => {
    const f: FDoc[] = [
      { id: 'x1', data: { status: 'pending', created_at: ts(NOW_MS - 10 * DAY_MS), createdAt: new Date(NOW_MS - 99 * DAY_MS).toISOString() } },
      { id: 'x2', data: { status: 'pending', created_at: null, createdAt: new Date(NOW_MS - 4 * DAY_MS).toISOString() } },
      { id: 'x3', data: { status: 'pending', created_at: ts(NOW_MS + 2 * DAY_MS) } },
    ];
    await expect(medianOf(f)).resolves.toEqual({ count: 3, medianDaysWaiting: 4.0 });
  });
});

describe('dashboard tasks union', () => {
  it('legacy statuses excluded from numerator and denominator', async () => {
    const union = ['completed', 'pending', 'in-progress', 'submitted-for-review', 'overdue'];
    const legacyOnly = DASH_TASKS.filter((d) => !union.includes(d.data.status));
    const payload = await run(dashStore({ tasks: toJsonbAll(legacyOnly) }));
    expect(payload.indicators.tasksCompleted).toBe(0);
    expect(payload.indicators.tasksOverdueRate).toBe(0);
  });

  it('zero denominator yields rate 0, never NaN (empty tasks)', async () => {
    const payload = await run(dashStore({ tasks: [] }));
    expect(payload.indicators.tasksCompleted).toBe(0);
    expect(payload.indicators.tasksOverdueRate).toBe(0);
  });
});

describe('dashboard audit latest 20', () => {
  it('latest 20 ids + ISO conversion', async () => {
    const payload = await run(dashStore());
    expect(payload.auditLogs.map((l) => l.id)).toEqual(
      DASH_AUDIT.slice(0, 20).map((d) => d.id),
    );
    expect(payload.auditLogs.map((l) => l.timestamp)).toEqual(
      DASH_AUDIT.slice(0, 20).map((d) =>
        new Date(NOW_MS - (DASH_AUDIT.indexOf(d) + 1) * 3_600_000).toISOString(),
      ),
    );
    expect(payload.auditLogs[0]).toEqual({
      id: 'ad01',
      action: 'role_assigned',
      targetUidOrResource: 'u1',
      timestamp: '2026-10-25T11:00:00.000Z',
    });
  });

  it('chapter scope with no matching audit docs yields an empty list', async () => {
    const payload = await run(dashStore(), 'ch-b');
    expect(payload.auditLogs).toEqual([]);
  });

  it('CONTRACT (divergence adjudicated): string-form timestamp is carried through, NOT replaced by now', async () => {
    const stored = DASH_AUDIT_STRING_TS.data.timestamp as string;
    const payload = await run(
      dashStore({ audit_logs: [toJsonb(DASH_AUDIT_STRING_TS)] }),
    );
    expect(payload.auditLogs).toHaveLength(1);
    expect(payload.auditLogs[0].timestamp).toBe(stored);
    expect(payload.auditLogs[0].timestamp).toBe('2026-10-24T06:00:00.000Z');
    expect(payload.auditLogs[0].timestamp).not.toBe(new Date(NOW_MS).toISOString());
  });

  it('timestamp-like audit values ({seconds} form, SupaTimestamp-like) convert to ISO', async () => {
    const ms = NOW_MS - 3_600_000;
    const store = dashStore({
      audit_logs: [
        { id: 's1', data: { action: 'a', targetUidOrResource: 'u1', timestamp: { seconds: Math.floor(ms / 1000), nanoseconds: 0 } } },
        {
          id: 's2',
          data: {
            action: 'b',
            targetUidOrResource: 'u2',
            timestamp: { toDate: () => new Date(ms - 3_600_000), toMillis: () => ms - 3_600_000 },
          },
        },
      ],
    });
    const payload = await run(store);
    // desc order: s1 (1h ago) before s2 (2h ago)
    expect(payload.auditLogs.map((l) => l.id)).toEqual(['s1', 's2']);
    expect(payload.auditLogs[0].timestamp).toBe(new Date(ms).toISOString());
    expect(payload.auditLogs[1].timestamp).toBe(new Date(ms - 3_600_000).toISOString());
  });
});

describe('route dispatch (tryAdminDashboardInitFromSupa)', () => {
  const savedEnv = process.env.SUPA_SURFACES;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedEnv;
    setAdminDashboardSupaAdapterForTests(null);
  });

  it('flag OFF (default): returns null and never touches the injected adapter', async () => {
    delete process.env.SUPA_SURFACES;
    const fake = new FakeSupaAdapter(dashStore());
    setAdminDashboardSupaAdapterForTests(fake);
    await expect(
      tryAdminDashboardInitFromSupa({ chapterId: null, nowMs: NOW_MS }),
    ).resolves.toBeNull();
    expect(fake.calls).toBe(0);
  });

  it('flag ON: returns the seam payload from the injected adapter', async () => {
    process.env.SUPA_SURFACES = 'other-surface, Admin-Dashboard ';
    const fake = new FakeSupaAdapter(dashStore());
    setAdminDashboardSupaAdapterForTests(fake);
    const payload = await tryAdminDashboardInitFromSupa({ chapterId: null, nowMs: NOW_MS });
    expect(payload?.metrics.users).toBe(6);
    expect(payload?.indicators.medianDaysWaiting).toBe(20.0);
    expect(fake.calls).toBeGreaterThan(0);
  });

  it('flag ON but adapter errors: returns null (route falls back to Firestore)', async () => {
    process.env.SUPA_SURFACES = 'admin-dashboard';
    const boom: AdminDashboardSupaAdapter = {
      countDocs: async () => {
        throw new Error('supa down');
      },
      listDocs: async () => {
        throw new Error('supa down');
      },
    };
    setAdminDashboardSupaAdapterForTests(boom);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      tryAdminDashboardInitFromSupa({ chapterId: null, nowMs: NOW_MS }),
    ).resolves.toBeNull();
    spy.mockRestore();
  });

  it('flag ON but no adapter available: returns null', async () => {
    process.env.SUPA_SURFACES = '*';
    setAdminDashboardSupaAdapterForTests(null);
    await expect(
      tryAdminDashboardInitFromSupa({ chapterId: null, nowMs: NOW_MS }),
    ).resolves.toBeNull();
  });
});
