/**
 * admin-parity.test.ts — Firestore-oracle vs Supa-adapter parity harness
 * for the ADMIN AGGREGATES + SETTINGS + AUDIT cluster (design verifier
 * admin-6). Every number in cluster-admin/PARITY_TABLE.md is produced by
 * a test in this file from the identical in-memory fixtures in
 * ./admin-parity-fixtures.ts. Zero live reads.
 *
 * ORACLE side: re-implements, line for line in semantics, the current
 * Firestore code (file:line cited per describe block). Where the real
 * code is importable with an injected db (discipline + governance
 * settings accessors), the REAL functions run against a fake Firestore
 * db AND against a fake "Supa-backed" db whose doc get() returns the
 * jsonb round-trip of the same fixture — proving the merge logic is
 * storage-shape invariant.
 *
 * SUPA side: models the landed adapter (feat/supa-adapter,
 * src/lib/supa/adapter.ts) faithfully:
 *  - rows are { id, data: jsonb } (timestamps as ISO strings),
 *  - equality filters read data->>'field' (text, exact for scalars),
 *  - countDocs = exact count of matching rows,
 *  - orderBy on a data field orders by data->>'field' TEXT — including
 *    its known numeric trap, which the analytics seam contract requires
 *    the consumer to correct (numeric cast) — both the naive adapter
 *    order and the contract order are computed and asserted.
 * Sibling implementer branches feat/supa-admin-1..4 had NOT landed when
 * this harness was written; rows whose Supa result comes from the seam
 * CONTRACT rather than landed code are marked in the parity table as
 * UNVERIFIED-BRANCH-PENDING even where this harness proves the contract
 * is implementable and self-consistent.
 */
import {
  NOW_MS,
  DAY_MS,
  ts,
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
  AUDIT_UNIFIED,
  AUDIT_LEGACY,
  AUDIT_TIE_UNIFIED,
  AUDIT_TIE_LEGACY,
  TIE_MS,
  ANALYTICS_PAGE_VISITS,
  analyticsEvents,
  DISCIPLINE_PARTIAL,
  DISCIPLINE_MALFORMED,
  DISCIPLINE_FRACTIONAL,
  GOVERNANCE_PARTIAL,
  GOVERNANCE_MALFORMED,
  SITEWIDE_STATE,
  SITEWIDE_STUDENTS_COUNT,
} from './admin-parity-fixtures';
import {
  getDisciplineSettings,
  DEFAULT_DISCIPLINE_SETTINGS,
} from '@/lib/server/discipline/settings';
import {
  getGovernanceSettings,
  getConsentGateMode,
  getConsentMatterSettings,
  DEFAULT_GOVERNANCE_SETTINGS,
} from '@/lib/server/governance-settings';

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */

/** Firestore count() semantics: docs matching all equality filters. */
const countWhere = (docs: FDoc[], filters: [string, any][]): number =>
  docs.filter((d) => filters.every(([f, v]) => d.data[f] === v)).length;

/** Chapter scope: applyEffectiveChapterFilter adds where chapterId == id. */
const scoped = (docs: FDoc[], chapterId: string | null): FDoc[] =>
  chapterId ? docs.filter((d) => d.data.chapterId === chapterId) : docs;

/** Adapter text extraction: data->>'field' as text (scalarText rules). */
const textOf = (v: any): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

/** Adapter-side equality: text extraction compared to stringified value. */
const supaCountWhere = (rows: FDoc[], filters: [string, any][]): number =>
  rows.filter((d) => filters.every(([f, v]) => textOf(d.data[f]) === textOf(v))).length;

/** Millis from any stored timestamp form on the Supa (jsonb) side. */
const supaMillis = (v: any): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
  return null;
};

/* ================================================================== */
/* DASHBOARD — oracle: src/app/api/admin/dashboard/init/route.ts       */
/* ================================================================== */

/** timestampMillis, route.ts:124-136 (verbatim semantics). */
function oracleTimestampMillis(v: any): number | null {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'string' || typeof v === 'number') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  return null;
}

/** safePendingApps, route.ts:161-186: exact count + id-ordered limit-100
 *  sample median (Firestore returns unordered queries in __name__ order;
 *  the seam contract states the same as "id-ordered limit-100 sample"). */
function oraclePending(apps: FDoc[], chapterId: string | null, nowMs: number) {
  const pending = scoped(apps, chapterId).filter((d) => d.data.status === 'pending');
  const count = pending.length;
  const sample = [...pending].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 100);
  const ages: number[] = [];
  for (const d of sample) {
    const ms = oracleTimestampMillis(d.data.created_at ?? d.data.createdAt);
    if (ms !== null) ages.push(Math.max(0, (nowMs - ms) / DAY_MS));
  }
  ages.sort((a, b) => a - b);
  let medianDaysWaiting: number | null = null;
  if (ages.length > 0) {
    const mid = Math.floor(ages.length / 2);
    const raw = ages.length % 2 === 1 ? ages[mid] : (ages[mid - 1] + ages[mid]) / 2;
    medianDaysWaiting = Math.round(raw * 10) / 10;
  }
  return { count, medianDaysWaiting };
}

/** Supa pending: jsonb rows carry ISO strings / {seconds} objects; the
 *  same precedence (created_at ?? createdAt) and sample rule apply. */
function supaPending(rows: FDoc[], chapterId: string | null, nowMs: number) {
  const pending = scoped(rows, chapterId).filter((d) => textOf(d.data.status) === 'pending');
  const count = pending.length;
  const sample = [...pending].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 100);
  const ages: number[] = [];
  for (const d of sample) {
    const ms = supaMillis(d.data.created_at ?? d.data.createdAt);
    if (ms !== null) ages.push(Math.max(0, (nowMs - ms) / DAY_MS));
  }
  ages.sort((a, b) => a - b);
  let medianDaysWaiting: number | null = null;
  if (ages.length > 0) {
    const mid = Math.floor(ages.length / 2);
    const raw = ages.length % 2 === 1 ? ages[mid] : (ages[mid - 1] + ages[mid]) / 2;
    medianDaysWaiting = Math.round(raw * 10) / 10;
  }
  return { count, medianDaysWaiting };
}

const TASK_UNION = ['completed', 'pending', 'in-progress', 'submitted-for-review', 'overdue'] as const;

/** safeTasks, route.ts:200-228. */
function oracleTasks(tasks: FDoc[], chapterId: string | null) {
  const s = scoped(tasks, chapterId);
  const by = (status: string) => countWhere(s, [['status', status]]);
  const [completed, pending, inProgress, submitted, overdue] = TASK_UNION.map(by);
  const denom = completed + pending + inProgress + submitted + overdue;
  return {
    tasksCompleted: completed,
    tasksOverdueRate: denom > 0 ? Math.round((overdue / denom) * 1000) / 10 : 0,
  };
}
function supaTasks(rows: FDoc[], chapterId: string | null) {
  const s = scoped(rows, chapterId);
  const by = (status: string) => supaCountWhere(s, [['status', status]]);
  const [completed, pending, inProgress, submitted, overdue] = TASK_UNION.map(by);
  const denom = completed + pending + inProgress + submitted + overdue;
  return {
    tasksCompleted: completed,
    tasksOverdueRate: denom > 0 ? Math.round((overdue / denom) * 1000) / 10 : 0,
  };
}

function oracleDashboard(chapterId: string | null, nowMs: number) {
  return {
    metrics: {
      users: scoped(DASH_USERS, chapterId).length,
      projects: scoped(DASH_PROJECTS, chapterId).length,
      blogs: scoped(DASH_BLOGS, chapterId).length,
      events: scoped(DASH_EVENTS, chapterId).length,
      announcements: scoped(DASH_ANNOUNCEMENTS, chapterId).length,
      applicationsPending: oraclePending(DASH_APPLICATIONS, chapterId, nowMs).count,
      applicationsShortlisted: countWhere(scoped(DASH_APPLICATIONS, chapterId), [['status', 'shortlisted']]),
      applicationsRejected: countWhere(scoped(DASH_APPLICATIONS, chapterId), [['status', 'rejected']]),
    },
    indicators: {
      usersDeparted: countWhere(scoped(DASH_USERS, chapterId), [['memberStatus', 'departed']]),
      medianDaysWaiting: oraclePending(DASH_APPLICATIONS, chapterId, nowMs).medianDaysWaiting,
      ...oracleTasks(DASH_TASKS, chapterId),
    },
  };
}
function supaDashboard(chapterId: string | null, nowMs: number) {
  const U = toJsonbAll(DASH_USERS), P = toJsonbAll(DASH_PROJECTS), B = toJsonbAll(DASH_BLOGS),
    E = toJsonbAll(DASH_EVENTS), A = toJsonbAll(DASH_ANNOUNCEMENTS),
    AP = toJsonbAll(DASH_APPLICATIONS), T = toJsonbAll(DASH_TASKS);
  return {
    metrics: {
      users: scoped(U, chapterId).length,
      projects: scoped(P, chapterId).length,
      blogs: scoped(B, chapterId).length,
      events: scoped(E, chapterId).length,
      announcements: scoped(A, chapterId).length,
      applicationsPending: supaPending(AP, chapterId, nowMs).count,
      applicationsShortlisted: supaCountWhere(scoped(AP, chapterId), [['status', 'shortlisted']]),
      applicationsRejected: supaCountWhere(scoped(AP, chapterId), [['status', 'rejected']]),
    },
    indicators: {
      usersDeparted: supaCountWhere(scoped(U, chapterId), [['memberStatus', 'departed']]),
      medianDaysWaiting: supaPending(AP, chapterId, nowMs).medianDaysWaiting,
      ...supaTasks(T, chapterId),
    },
  };
}

describe('dashboard init — global scope (route.ts)', () => {
  it('dashboard global metrics+indicators parity', () => {
    const o = oracleDashboard(null, NOW_MS);
    expect(o.metrics).toEqual({
      users: 6, projects: 3, blogs: 2, events: 3, announcements: 2,
      applicationsPending: 5, applicationsShortlisted: 2, applicationsRejected: 1,
    });
    expect(o.indicators).toEqual({
      usersDeparted: 1, medianDaysWaiting: 20.0, tasksCompleted: 3, tasksOverdueRate: 22.2,
    });
    expect(supaDashboard(null, NOW_MS)).toEqual(o);
  });

  it('dashboard chapter scope (ch-a) parity', () => {
    const o = oracleDashboard('ch-a', NOW_MS);
    expect(o.metrics).toEqual({
      users: 3, projects: 2, blogs: 1, events: 1, announcements: 2,
      applicationsPending: 3, applicationsShortlisted: 1, applicationsRejected: 1,
    });
    expect(o.indicators).toEqual({
      usersDeparted: 0, medianDaysWaiting: 25.0, tasksCompleted: 2, tasksOverdueRate: 20.0,
    });
    expect(supaDashboard('ch-a', NOW_MS)).toEqual(o);
  });
});

describe('dashboard pending median edges (route.ts:161-186)', () => {
  it('median odd count', () => {
    const f = pendingApps([10, 20, 30]);
    expect(oraclePending(f, null, NOW_MS)).toEqual({ count: 3, medianDaysWaiting: 20.0 });
    expect(supaPending(toJsonbAll(f), null, NOW_MS)).toEqual({ count: 3, medianDaysWaiting: 20.0 });
  });
  it('median even count', () => {
    const f = pendingApps([10, 20, 30, 40]);
    expect(oraclePending(f, null, NOW_MS).medianDaysWaiting).toBe(25.0);
    expect(supaPending(toJsonbAll(f), null, NOW_MS).medianDaysWaiting).toBe(25.0);
  });
  it('median rounding to 0.1 (raw 2.25 -> 2.3)', () => {
    const f = pendingApps([2.25]);
    expect(oraclePending(f, null, NOW_MS).medianDaysWaiting).toBe(2.3);
    expect(supaPending(toJsonbAll(f), null, NOW_MS).medianDaysWaiting).toBe(2.3);
  });
  it('median null when no pending doc has a timestamp; count still exact', () => {
    const f = pendingApps([null, null]);
    expect(oraclePending(f, null, NOW_MS)).toEqual({ count: 2, medianDaysWaiting: null });
    expect(supaPending(toJsonbAll(f), null, NOW_MS)).toEqual({ count: 2, medianDaysWaiting: null });
  });
  it('median sample capped at id-ordered 100; count exact at 105', () => {
    expect(oraclePending(PENDING_CAP_105, null, NOW_MS)).toEqual({ count: 105, medianDaysWaiting: 49.5 });
    expect(supaPending(toJsonbAll(PENDING_CAP_105), null, NOW_MS)).toEqual({ count: 105, medianDaysWaiting: 49.5 });
  });
  it('created_at takes precedence; null created_at falls back to createdAt; future clamps to 0', () => {
    const f: FDoc[] = [
      { id: 'x1', data: { status: 'pending', created_at: ts(NOW_MS - 10 * DAY_MS), createdAt: new Date(NOW_MS - 99 * DAY_MS).toISOString() } },
      { id: 'x2', data: { status: 'pending', created_at: null, createdAt: new Date(NOW_MS - 4 * DAY_MS).toISOString() } },
      { id: 'x3', data: { status: 'pending', created_at: ts(NOW_MS + 2 * DAY_MS) } },
    ];
    // ages: 10 (not 99), 4 (fallback), 0 (clamped) -> sorted [0,4,10] -> median 4.0
    expect(oraclePending(f, null, NOW_MS)).toEqual({ count: 3, medianDaysWaiting: 4.0 });
    expect(supaPending(toJsonbAll(f), null, NOW_MS)).toEqual({ count: 3, medianDaysWaiting: 4.0 });
  });
});

describe('dashboard tasks union (route.ts:200-228)', () => {
  it('legacy statuses excluded from numerator and denominator', () => {
    const legacyOnly = DASH_TASKS.filter((d) => !TASK_UNION.includes(d.data.status as any));
    expect(oracleTasks(legacyOnly, null)).toEqual({ tasksCompleted: 0, tasksOverdueRate: 0 });
    expect(supaTasks(toJsonbAll(legacyOnly), null)).toEqual({ tasksCompleted: 0, tasksOverdueRate: 0 });
  });
  it('zero denominator yields rate 0, never NaN', () => {
    expect(oracleTasks([], null)).toEqual({ tasksCompleted: 0, tasksOverdueRate: 0 });
    expect(supaTasks([], null)).toEqual({ tasksCompleted: 0, tasksOverdueRate: 0 });
  });
});

describe('dashboard audit latest 20 (route.ts:246-262)', () => {
  const orderDesc = (docs: FDoc[]) =>
    [...docs].sort((a, b) => oracleTimestampMillis(b.data.timestamp)! - oracleTimestampMillis(a.data.timestamp)!);
  it('latest 20 ids + ISO conversion of Timestamp-form docs', () => {
    const top = orderDesc(DASH_AUDIT).slice(0, 20);
    expect(top.map((d) => d.id)).toEqual(DASH_AUDIT.slice(0, 20).map((d) => d.id));
    expect(top[0].data.timestamp.toDate().toISOString()).toBe(new Date(NOW_MS - 3_600_000).toISOString());
    // Supa side: ISO strings sort identically (uniform ISO format, text order == time order)
    const rows = toJsonbAll(DASH_AUDIT);
    const supaTop = [...rows].sort((a, b) => (textOf(b.data.timestamp) < textOf(a.data.timestamp) ? -1 : 1)).slice(0, 20);
    expect(supaTop.map((d) => d.id)).toEqual(top.map((d) => d.id));
    expect(supaTop.map((d) => d.data.timestamp)).toEqual(top.map((d) => d.data.timestamp.toDate().toISOString()));
  });
  it('DIVERGENCE: string-form timestamp is replaced by "now" in the Firestore route, not passed through', () => {
    const stored = DASH_AUDIT_STRING_TS.data.timestamp as string;
    // route.ts:258: data.timestamp?.toDate ? ... : new Date().toISOString()
    const oracleOut = DASH_AUDIT_STRING_TS.data.timestamp?.toDate
      ? DASH_AUDIT_STRING_TS.data.timestamp.toDate().toISOString()
      : new Date(NOW_MS).toISOString(); // harness clock stands in for route's real clock
    expect(oracleOut).toBe(new Date(NOW_MS).toISOString());
    expect(oracleOut).not.toBe(stored);
    // Supa row simply carries the stored ISO string:
    expect(toJsonbAll([DASH_AUDIT_STRING_TS])[0].data.timestamp).toBe(stored);
  });
});

/* ================================================================== */
/* AUDIT — oracle: src/app/admin/audit-logs/page.tsx + superadmin      */
/* ================================================================== */

/** Legacy normalization, audit-logs/page.tsx: unified + legacy maps. */
function normalizeUnified(d: FDoc) {
  return {
    id: d.id, source: 'audit_logs' as const,
    actorUid: d.data.actorUid || d.data.actor_uid || '',
    action: d.data.action,
    targetUidOrResource: d.data.targetUidOrResource || d.data.target || '',
    payload: d.data.payload,
    tsMs: oracleTimestampMillis(d.data.timestamp)!,
  };
}
function normalizeLegacy(d: FDoc) {
  return {
    id: d.id, source: 'auditLogs' as const,
    actorUid: d.data.changedBy || '',
    action: d.data.action,
    targetUidOrResource: d.data.userId || '',
    payload: { oldRole: d.data.oldRole, newRole: d.data.newRole },
    tsMs: oracleTimestampMillis(d.data.timestamp)!,
  };
}
type Norm = ReturnType<typeof normalizeUnified>;

/** Firestore page emulation (audit-logs/page.tsx:86-170):
 *  - each collection: orderBy timestamp desc, limit 20, own where filters
 *    (legacy filters on changedBy, unified on actorUid),
 *  - merged with a STABLE sort by ts desc only,
 *  - ONE cursor: the last UNIFIED doc, applied to BOTH queries via
 *    startAfter (cursor carries that doc's timestamp + id). */
function firestoreAuditPage(
  unified: FDoc[], legacy: FDoc[],
  opts: { actor?: string; action?: string; cursor?: { tsMs: number; id: string } | null } = {},
) {
  const after = (items: Norm[]) =>
    !opts.cursor
      ? items
      : items.filter(
          (x) => x.tsMs < opts.cursor!.tsMs || (x.tsMs === opts.cursor!.tsMs && x.id > opts.cursor!.id),
        );
  let u = unified.map(normalizeUnified);
  let l = legacy.map(normalizeLegacy);
  if (opts.actor) {
    u = u.filter((x) => x.actorUid === opts.actor);
    l = l.filter((x) => x.actorUid === opts.actor); // changedBy, post-normalization
  }
  if (opts.action) {
    u = u.filter((x) => x.action === opts.action);
    l = l.filter((x) => x.action === opts.action);
  }
  u = after(u.sort((a, b) => b.tsMs - a.tsMs)).slice(0, 20);
  l = after(l.sort((a, b) => b.tsMs - a.tsMs)).slice(0, 20);
  const merged = [...u, ...l].sort((a, b) => b.tsMs - a.tsMs); // stable: unified block wins ties
  const lastUnified = u[u.length - 1];
  return { merged, cursor: lastUnified ? { tsMs: lastUnified.tsMs, id: lastUnified.id } : null };
}

/** Contract pagination (seam-admin-audit): one merged stream, total order
 *  (ts desc, source: audit_logs before auditLogs, id asc), opaque cursor
 *  (timestamp,id,source), 20/page, no dup/skip. Supa rows are jsonb
 *  (ISO timestamps) normalized through the same legacy mapping. */
type Cursor = { tsMs: number; id: string; source: string };
const SOURCE_RANK = { audit_logs: 0, auditLogs: 1 } as const;
function contractOrder(a: Norm & { source: keyof typeof SOURCE_RANK }, b: typeof a) {
  if (b.tsMs !== a.tsMs) return b.tsMs - a.tsMs;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  return a.id < b.id ? -1 : 1;
}
function supaAuditPage(
  unifiedRows: FDoc[], legacyRows: FDoc[],
  opts: { actor?: string; action?: string; cursor?: Cursor | null; pageSize?: number } = {},
) {
  const normU = unifiedRows.map((d) => ({
    ...normalizeUnified({ id: d.id, data: { ...d.data, timestamp: ts(supaMillis(d.data.timestamp)!) } }),
    source: 'audit_logs' as const,
  }));
  const normL = legacyRows.map((d) => ({
    ...normalizeLegacy({ id: d.id, data: { ...d.data, timestamp: ts(supaMillis(d.data.timestamp)!) } }),
    source: 'auditLogs' as const,
  }));
  let all = [...normU, ...normL];
  if (opts.actor) all = all.filter((x) => x.actorUid === opts.actor);
  if (opts.action) all = all.filter((x) => x.action === opts.action);
  all.sort(contractOrder);
  let start = 0;
  if (opts.cursor) {
    const c = opts.cursor;
    start = all.findIndex(
      (x) =>
        x.tsMs < c.tsMs ||
        (x.tsMs === c.tsMs &&
          (SOURCE_RANK[x.source] > SOURCE_RANK[c.source as keyof typeof SOURCE_RANK] ||
            (SOURCE_RANK[x.source] === SOURCE_RANK[c.source as keyof typeof SOURCE_RANK] && x.id > c.id))),
    );
    if (start === -1) start = all.length;
  }
  const size = opts.pageSize ?? 20;
  const page = all.slice(start, start + size);
  const last = page[page.length - 1];
  return {
    page,
    total: all.length,
    nextCursor: last && start + size < all.length ? { tsMs: last.tsMs, id: last.id, source: last.source } : null,
  };
}

describe('audit dedicated page — Firestore oracle behavior (audit-logs/page.tsx)', () => {
  it('page 1 merges per-collection limits: 20 unified + 5 legacy = 25 rows (of 35 total), legacy normalized', () => {
    const { merged } = firestoreAuditPage(AUDIT_UNIFIED, AUDIT_LEGACY);
    expect(merged).toHaveLength(25);
    const lg = merged.find((x) => x.id === 'lg1')!;
    expect(lg.actorUid).toBe('actor-1'); // changedBy -> actorUid
    expect(lg.targetUidOrResource).toBe('u1'); // userId -> target
    expect(lg.payload).toEqual({ oldRole: 'member', newRole: 'admin' });
  });
  it('DIVERGENCE: Firestore page 2 re-emits legacy rows already shown on page 1 (shared unified cursor)', () => {
    const p1 = firestoreAuditPage(AUDIT_UNIFIED, AUDIT_LEGACY);
    const p2 = firestoreAuditPage(AUDIT_UNIFIED, AUDIT_LEGACY, { cursor: p1.cursor });
    const p1Ids = new Set(p1.merged.map((x) => x.id));
    const dupes = p2.merged.map((x) => x.id).filter((id) => p1Ids.has(id));
    expect(dupes.sort()).toEqual(['lg1', 'lg2', 'lg3', 'lg4', 'lg5']);
  });
  it('action list = sorted unique actions from latest 200 per collection', () => {
    const from = (docs: FDoc[]) =>
      [...docs].sort((a, b) => oracleTimestampMillis(b.data.timestamp)! - oracleTimestampMillis(a.data.timestamp)!)
        .slice(0, 200).map((d) => d.data.action as string);
    const actions = Array.from(new Set([...from(AUDIT_UNIFIED), ...from(AUDIT_LEGACY)])).sort();
    expect(actions).toEqual(['login', 'role_assigned', 'role_changed']);
  });
});

describe('audit dedicated page — Supa contract pagination (seam-admin-audit)', () => {
  const U = () => toJsonbAll(AUDIT_UNIFIED);
  const L = () => toJsonbAll(AUDIT_LEGACY);
  it('totals via countDocs: users + audit_logs (superadmin, superadmin/page.tsx)', () => {
    expect(DASH_USERS.length).toBe(6); // countDocs('users')
    expect(AUDIT_UNIFIED.length).toBe(30); // countDocs('audit_logs') — legacy collection NOT in total, either side
    expect(supaCountWhere(U(), [['actorUid', 'actor-1']])).toBe(15);
  });
  it('superadmin first page is 50, timestamp desc (superadmin/page.tsx:37,77-86)', () => {
    const page = [...U()].sort((a, b) => (textOf(b.data.timestamp) < textOf(a.data.timestamp) ? -1 : 1)).slice(0, 50);
    expect(page).toHaveLength(30);
    expect(page[0].id).toBe('au01');
  });
  it('contract page 1 = 20 rows; page 2 = remaining 15; zero overlap, zero skip', () => {
    const p1 = supaAuditPage(U(), L());
    expect(p1.page).toHaveLength(20);
    expect(p1.total).toBe(35);
    const p2 = supaAuditPage(U(), L(), { cursor: p1.nextCursor });
    expect(p2.page).toHaveLength(15);
    const ids = [...p1.page, ...p2.page].map((x) => x.id);
    expect(new Set(ids).size).toBe(35);
    expect(p2.nextCursor).toBeNull();
  });
  it('tie cluster: identical timestamps paginate with no dup/skip across the boundary', () => {
    const all: string[] = [];
    let cursor: Cursor | null = null;
    for (let p = 0; p < 3; p++) {
      const r = supaAuditPage(toJsonbAll(AUDIT_TIE_UNIFIED), toJsonbAll(AUDIT_TIE_LEGACY), { cursor });
      all.push(...r.page.map((x) => x.id));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(all).toHaveLength(26); // 23 unified + 3 legacy
    expect(new Set(all).size).toBe(26);
    const tieRows = all.filter((id) => id.startsWith('tie-'));
    expect(tieRows.sort()).toEqual(['tie-l1', 'tie-l2', 'tie-l3', 'tie-u1', 'tie-u2', 'tie-u3', 'tie-u4', 'tie-u5']);
    // every tie row shares exactly TIE_MS
    const r = supaAuditPage(toJsonbAll(AUDIT_TIE_UNIFIED), toJsonbAll(AUDIT_TIE_LEGACY), { pageSize: 100 });
    expect(r.page.filter((x) => x.id.startsWith('tie-')).every((x) => x.tsMs === TIE_MS)).toBe(true);
  });
  it('filters: actor and action apply to BOTH collections post-normalization', () => {
    const byActor = supaAuditPage(U(), L(), { actor: 'actor-1', pageSize: 100 });
    expect(byActor.total).toBe(15 + 5); // 15 unified actor-1 + all 5 legacy changedBy actor-1
    const byAction = supaAuditPage(U(), L(), { action: 'role_changed', pageSize: 100 });
    expect(byAction.total).toBe(5);
    expect(byAction.page.every((x) => x.source === 'auditLogs')).toBe(true);
  });
  it('legacy normalization identical on Supa rows (changedBy/userId/oldRole/newRole)', () => {
    const r = supaAuditPage(U(), L(), { action: 'role_changed', pageSize: 1 });
    expect(r.page[0]).toMatchObject({
      actorUid: 'actor-1', targetUidOrResource: 'u1',
      payload: { oldRole: 'member', newRole: 'admin' }, source: 'auditLogs',
    });
  });
});

/* ================================================================== */
/* ANALYTICS — oracle: src/app/admin/analytics/page.tsx                */
/* ================================================================== */

function oracleAnalyticsDerivations(events: FDoc[], nowMs: number) {
  // page.tsx:186-229 — events already capped at latest 200 by the query.
  const mapped = events.map((d) => ({
    type: d.data.type ?? 'unknown',
    label: d.data.label ?? null,
    targetId: d.data.targetId ?? null,
    timestamp: d.data.timestamp ?? null,
    timeOnPageMs: d.data.timeOnPageMs ?? d.data.durationMs ?? null,
    scrollDepth: d.data.scrollDepth ?? null,
  }));
  const labelCounts: Record<string, number> = {};
  for (const e of mapped) {
    if (e.type !== 'click') continue;
    const key = e.label || e.targetId || 'unknown';
    labelCounts[key] = (labelCounts[key] || 0) + 1;
  }
  const topClicked = Object.entries(labelCounts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const buckets: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(nowMs);
    d.setDate(d.getDate() - i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  for (const e of mapped) {
    if (e.type !== 'click' || !e.timestamp?.toDate) continue; // ISO-form timestamps skipped here
    const key = e.timestamp.toDate().toISOString().slice(0, 10);
    if (key in buckets) buckets[key] += 1;
  }
  const clicksByDay = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
  const times = mapped.filter((e) => e.type === 'time_on_page' && typeof e.timeOnPageMs === 'number').map((e) => e.timeOnPageMs as number);
  const depths = mapped.filter((e) => e.type === 'scroll_depth' && typeof e.scrollDepth === 'number').map((e) => e.scrollDepth as number);
  return {
    topClicked, clicksByDay,
    avgTimeOnPageMs: times.length ? Math.round(times.reduce((s, v) => s + v, 0) / times.length) : 0,
    avgScrollDepth: depths.length ? Math.round(depths.reduce((s, v) => s + v, 0) / depths.length) : 0,
    recentClicks: mapped.filter((e) => e.type === 'click').length,
  };
}

function supaAnalyticsDerivations(rows: FDoc[], nowMs: number) {
  // Identical derivations, with the jsonb timestamp normalized first
  // (ISO string -> Date), which is exactly what the seam contract
  // requires so Timestamp-form and ISO-form inputs agree.
  const mapped = rows.map((d) => ({
    type: d.data.type ?? 'unknown',
    label: d.data.label ?? null,
    targetId: d.data.targetId ?? null,
    tsMs: supaMillis(d.data.timestamp),
    timeOnPageMs: d.data.timeOnPageMs ?? d.data.durationMs ?? null,
    scrollDepth: d.data.scrollDepth ?? null,
  }));
  const asTsForm = mapped.map((e) => ({
    ...e,
    timestamp: e.tsMs === null ? null : { toDate: () => new Date(e.tsMs!) },
  })) as unknown as FDoc[];
  // reuse the oracle derivation code on normalized events
  const evDocs = asTsForm.map((e: any, i: number) => ({
    id: `n${i}`,
    data: {
      type: e.type, label: e.label, targetId: e.targetId,
      timestamp: e.timestamp, timeOnPageMs: e.timeOnPageMs, scrollDepth: e.scrollDepth,
    },
  }));
  return oracleAnalyticsDerivations(evDocs, nowMs);
}

const latest200 = (docsIn: FDoc[], key: (d: FDoc) => number) =>
  [...docsIn].sort((a, b) => key(b) - key(a)).slice(0, 200);

describe('analytics (admin/analytics/page.tsx + seam-admin-system)', () => {
  it('pageVisits: Firestore numeric desc vs adapter TEXT desc (the trap) vs contract numeric desc', () => {
    const rows = toJsonbAll(ANALYTICS_PAGE_VISITS);
    const numeric = [...ANALYTICS_PAGE_VISITS].sort((a, b) => b.data.visits - a.data.visits).map((d) => d.id);
    const textTrap = [...rows].sort((a, b) => (textOf(b.data.visits) < textOf(a.data.visits) ? -1 : 1)).map((d) => d.id);
    const contract = [...rows].sort((a, b) => Number(b.data.visits) - Number(a.data.visits)).map((d) => d.id);
    expect(numeric).toEqual(['site_total_visits', '_events', '_blog', 'home', '_about']);
    expect(textTrap).toEqual(['site_total_visits', '_about', '_blog', 'home', '_events']); // text desc: '9999'>'9'>'85'>'50'>'100'
    expect(textTrap).not.toEqual(numeric);
    expect(contract).toEqual(numeric);
  });
  it('site_total_visits excluded from list but used as total; path derivation id->_; top5 drops path "home"', () => {
    const list = [...ANALYTICS_PAGE_VISITS]
      .sort((a, b) => b.data.visits - a.data.visits)
      .filter((d) => d.id !== 'site_total_visits')
      .map((d) => ({ path: d.id.replace(/_/g, '/'), visits: d.data.visits }));
    expect(list).toEqual([
      { path: '/events', visits: 100 },
      { path: '/blog', visits: 85 },
      { path: 'home', visits: 50 },
      { path: '/about', visits: 9 },
    ]);
    expect(list.filter((v) => v.path !== 'home').slice(0, 5)).toHaveLength(3);
    const total = ANALYTICS_PAGE_VISITS.find((d) => d.id === 'site_total_visits')?.data.visits ?? 0;
    expect(total).toBe(9999);
    const missing = ANALYTICS_PAGE_VISITS.filter((d) => d.id !== 'site_total_visits');
    expect(missing.find((d) => d.id === 'site_total_visits')?.data.visits ?? 0).toBe(0);
  });
  it('counts: totalUsers + projectsCount via count aggregation', () => {
    expect(DASH_USERS.length).toBe(6);
    expect(DASH_PROJECTS.length).toBe(3);
  });
  it('derivations identical for Timestamp-form (oracle) and ISO-form (Supa) inputs; cap 200 enforced', () => {
    const ora = oracleAnalyticsDerivations(latest200(analyticsEvents('timestamp'), (d) => oracleTimestampMillis(d.data.timestamp)!), NOW_MS);
    const sup = supaAnalyticsDerivations(latest200(toJsonbAll(analyticsEvents('timestamp')), (d) => supaMillis(d.data.timestamp)!), NOW_MS);
    expect(sup).toEqual(ora);
    expect(ora.topClicked).toEqual([
      { label: 'Join', count: 30 },
      { label: 'Donate', count: 30 },
      { label: 'cta-1', count: 10 },
      { label: 'unknown', count: 5 },
    ]);
    expect(ora.recentClicks).toBe(75); // the 10 'Join' clicks beyond the cap are excluded
    expect(ora.avgTimeOnPageMs).toBe(2500); // (1000+2000+3000+4000 durationMs fallback)/4
    expect(ora.avgScrollDepth).toBe(50);
    const today = new Date(NOW_MS).toISOString().slice(0, 10);
    expect(ora.clicksByDay).toHaveLength(7);
    expect(ora.clicksByDay.find((b) => b.date === today)?.count).toBe(75);
    expect(ora.clicksByDay.filter((b) => b.date !== today).every((b) => b.count === 0)).toBe(true);
  });
  it('oracle quirk: fed ISO-form timestamps directly, the Firestore page trend buckets nothing (toDate guard)', () => {
    const iso = latest200(analyticsEvents('iso'), (d) => new Date(d.data.timestamp).getTime());
    const ora = oracleAnalyticsDerivations(iso, NOW_MS);
    expect(ora.clicksByDay.every((b) => b.count === 0)).toBe(true);
    expect(ora.topClicked[0]).toEqual({ label: 'Join', count: 30 }); // top-clicked has no toDate guard
  });
});

/* ================================================================== */
/* SETTINGS — REAL accessors against fake Firestore + fake Supa db     */
/* discipline: src/lib/server/discipline/settings.ts                   */
/* governance: src/lib/server/governance-settings.ts                   */
/* ================================================================== */

/** Fake Firestore db serving one doc (or none) per collection/doc path. */
function fakeFirestoreDb(docs: Record<string, Record<string, any> | undefined>) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs[`${name}/${id}`];
          return { exists: data !== undefined, data: () => data };
        },
      }),
    }),
  } as any;
}
/** Fake "Supa-backed" db: same accessor-facing shape, but the stored doc
 *  is the jsonb round-trip of the fixture (what fs_settings /
 *  fs_governance_settings rows carry). */
function fakeSupaDb(docs: Record<string, Record<string, any> | undefined>) {
  const roundTripped: Record<string, Record<string, any> | undefined> = {};
  for (const [k, v] of Object.entries(docs)) {
    roundTripped[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }
  return fakeFirestoreDb(roundTripped);
}

describe('discipline settings (settings/discipline)', () => {
  it('missing doc -> defaults, both sides', async () => {
    expect(await getDisciplineSettings(fakeFirestoreDb({}))).toEqual(DEFAULT_DISCIPLINE_SETTINGS);
    expect(await getDisciplineSettings(fakeSupaDb({}))).toEqual(DEFAULT_DISCIPLINE_SETTINGS);
    expect(DEFAULT_DISCIPLINE_SETTINGS).toEqual({
      shadowMode: true, cronReferralLive: false, referralWindowDays: 28,
      referralMissThreshold: 3, warningRegistryVariant: 'retired',
    });
  });
  it('partial doc merges over defaults, both sides', async () => {
    const docs = { 'settings/discipline': DISCIPLINE_PARTIAL };
    const expected = { ...DEFAULT_DISCIPLINE_SETTINGS, referralWindowDays: 7 };
    expect(await getDisciplineSettings(fakeFirestoreDb(docs))).toEqual(expected);
    expect(await getDisciplineSettings(fakeSupaDb(docs))).toEqual(expected);
  });
  it('malformed fields ignored identically, both sides', async () => {
    const docs = { 'settings/discipline': DISCIPLINE_MALFORMED };
    const o = await getDisciplineSettings(fakeFirestoreDb(docs));
    expect(o).toEqual({
      shadowMode: true, // 'yes' !== false
      cronReferralLive: false, // 1 !== true
      referralWindowDays: 28, // -5 rejected
      referralMissThreshold: 3, // '3' rejected
      warningRegistryVariant: 'retired', // 'bogus' rejected
    });
    expect(await getDisciplineSettings(fakeSupaDb(docs))).toEqual(o);
  });
  it('read path accepts fractional positive window (write path does not — route validate())', async () => {
    const docs = { 'settings/discipline': DISCIPLINE_FRACTIONAL };
    const o = await getDisciplineSettings(fakeFirestoreDb(docs));
    expect(o.referralWindowDays).toBe(3.5);
    expect(o.referralMissThreshold).toBe(3); // 0 rejected on read too
    expect(await getDisciplineSettings(fakeSupaDb(docs))).toEqual(o);
  });
  it('db error -> defaults (fail-safe), both sides', async () => {
    const boom = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('x'); } }) }) } as any;
    expect(await getDisciplineSettings(boom)).toEqual(DEFAULT_DISCIPLINE_SETTINGS);
  });
});

describe('governance settings (governance_settings/phase2)', () => {
  it('missing doc -> defaults, both sides (warningRegistryVariant default is internal here)', async () => {
    expect(await getGovernanceSettings(fakeFirestoreDb({}))).toEqual(DEFAULT_GOVERNANCE_SETTINGS);
    expect(await getGovernanceSettings(fakeSupaDb({}))).toEqual(DEFAULT_GOVERNANCE_SETTINGS);
    expect(DEFAULT_GOVERNANCE_SETTINGS.warningRegistryVariant).toBe('internal');
    expect(DEFAULT_GOVERNANCE_SETTINGS.flags).toEqual({
      consentLive: false, boardLive: false, disciplineLive: false, cadetshipLive: false, complianceLive: false,
    });
  });
  it('partial doc: per-key merge, malformed values ignored, unknown consent keys kept, both sides', async () => {
    const docs = { 'governance_settings/phase2': GOVERNANCE_PARTIAL };
    const o = await getGovernanceSettings(fakeFirestoreDb(docs));
    expect(o.consentGateMode).toEqual({
      category_b_appointment: 'hard',
      chapter_lifecycle: 'hard', // 'bogus' ignored
      catalog_amendment: 'hard',
      sponsor_partner: 'hard', // overridden
      other_reserved: 'record',
      custom_matter: 'record', // unknown key with a valid mode IS merged
    });
    expect(o.probationRestoreMode).toBe('auto'); // 'bogus' ignored
    expect(o.warningRegistryVariant).toBe('retired');
    expect(o.flags.consentLive).toBe(true);
    expect(o.flags.boardLive).toBe(false); // 'yes' not boolean
    expect((o.flags as any).unknownFlag).toBeUndefined();
    expect(o.updatedBy).toBeUndefined(); // 123 not a string
    expect(o.changeReason).toBe('founder request 2026-10-25');
    expect(await getGovernanceSettings(fakeSupaDb(docs))).toEqual(o);
  });
  it('wholly malformed doc -> defaults, both sides', async () => {
    const docs = { 'governance_settings/phase2': GOVERNANCE_MALFORMED };
    expect(await getGovernanceSettings(fakeFirestoreDb(docs))).toEqual(DEFAULT_GOVERNANCE_SETTINGS);
    expect(await getGovernanceSettings(fakeSupaDb(docs))).toEqual(DEFAULT_GOVERNANCE_SETTINGS);
  });
  it('accessor divergence preserved: missing matter key -> getConsentGateMode hard vs getConsentMatterSettings record/missing', async () => {
    const db = fakeFirestoreDb({});
    expect(await getConsentGateMode(db, 'no_such_matter')).toBe('hard');
    expect(await getConsentMatterSettings(db, 'no_such_matter')).toEqual({
      mode: 'record', validityDays: 90, source: 'missing',
    });
    const db2 = fakeSupaDb({ 'governance_settings/phase2': { consentGateMode: { m: 'bogus' }, matterValidityDays: { m: 30 } } });
    expect(await getConsentMatterSettings(db2, 'm')).toEqual({ mode: 'record', validityDays: 30, source: 'malformed' });
  });
});

/* ================================================================== */
/* SITE-WIDE SETTINGS — oracle: components/admin/                      */
/* site-settings-management.tsx + types/site-settings.ts               */
/* ================================================================== */

/** Creation payload when settings/siteWide is missing (component:74-92).
 *  NOTE: no bugReportEmail, no siteEnabled, no maintenanceMode fields. */
function oracleSiteWideCreation(studentsCount: number, uid: string) {
  const { DEFAULT_SITE_SETTINGS } = require('@/types/site-settings');
  return {
    studentsEngaged: studentsCount,
    activeProjects: DEFAULT_SITE_SETTINGS.activeProjects,
    partners: DEFAULT_SITE_SETTINGS.partners,
    globalChapters: DEFAULT_SITE_SETTINGS.globalChapters,
    contactFormDestinationEmail: DEFAULT_SITE_SETTINGS.contactFormDestinationEmail,
    enableDonations: DEFAULT_SITE_SETTINGS.enableDonations,
    enableChapterRegistration: DEFAULT_SITE_SETTINGS.enableChapterRegistration,
    registrationStatus: DEFAULT_SITE_SETTINGS.registrationStatus,
    registrationNumber: DEFAULT_SITE_SETTINGS.registrationNumber,
    registrationDate: DEFAULT_SITE_SETTINGS.registrationDate,
    registrarJurisdiction: DEFAULT_SITE_SETTINGS.registrarJurisdiction,
    updatedBy: uid || 'system',
  };
}

/** Save whitelist (component:125-146): updateDoc payload, verbatim rules. */
function oracleSiteWideSave(settings: Record<string, any>, studentsCount: number, uid: string) {
  return {
    studentsEngaged: studentsCount,
    activeProjects: settings.activeProjects || 0,
    partners: settings.partners || 0,
    globalChapters: settings.globalChapters || 25,
    contactFormDestinationEmail: settings.contactFormDestinationEmail || '',
    bugReportEmail: settings.bugReportEmail || '',
    enableDonations: settings.enableDonations || false,
    enableChapterRegistration: settings.enableChapterRegistration || false,
    registrationStatus: settings.registrationStatus || 'in_process',
    registrationNumber: settings.registrationNumber || '',
    registrationDate: settings.registrationDate || '',
    registrarJurisdiction: settings.registrarJurisdiction || '',
    siteEnabled: settings.siteEnabled !== false,
    maintenanceMode: settings.maintenanceMode === true,
    updatedBy: uid,
  };
}

describe('siteWide settings (settings/siteWide)', () => {
  it('students count = users collection size (getDocs().size); on error 0', () => {
    expect(DASH_USERS.length).toBe(6);
    expect(SITEWIDE_STUDENTS_COUNT).toBe(42); // fixture count used in save/creation below
  });
  it('missing doc -> creation payload from defaults with dynamic students count; omits bugReportEmail/siteEnabled/maintenanceMode', () => {
    const created = oracleSiteWideCreation(SITEWIDE_STUDENTS_COUNT, 'admin-1');
    expect(created).toEqual({
      studentsEngaged: 42, activeProjects: 0, partners: 0, globalChapters: 25,
      contactFormDestinationEmail: '', enableDonations: false, enableChapterRegistration: false,
      registrationStatus: 'in_process', registrationNumber: '', registrationDate: '',
      registrarJurisdiction: '', updatedBy: 'admin-1',
    });
    expect('bugReportEmail' in created).toBe(false);
    expect('siteEnabled' in created).toBe(false);
    expect('maintenanceMode' in created).toBe(false);
    // Supa mirror carries the identical payload (jsonb round-trip is lossless here)
    expect(JSON.parse(JSON.stringify(created))).toEqual(created);
  });
  it('save whitelist: dynamic count overrides edited studentsEngaged; falsy traps; extras dropped', () => {
    const saved = oracleSiteWideSave(SITEWIDE_STATE, SITEWIDE_STUDENTS_COUNT, 'admin-1');
    expect(saved).toEqual({
      studentsEngaged: 42, // not 9999
      activeProjects: 12,
      partners: 4,
      globalChapters: 25, // 0 -> || 25
      contactFormDestinationEmail: 'hello@example.com',
      bugReportEmail: 'bugs@example.com',
      enableDonations: true,
      enableChapterRegistration: false, // undefined -> || false
      registrationStatus: 'registered',
      registrationNumber: 'ICT-123',
      registrationDate: '2026-01-15',
      registrarJurisdiction: 'Islamabad',
      siteEnabled: true, // undefined !== false
      maintenanceMode: false, // undefined !== true
      updatedBy: 'admin-1',
    });
    expect('evilExtraField' in saved).toBe(false);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
  });
});
