/**
 * admin-audit-supa — the ONE seam between the ADMIN AUDIT surface group
 * (superadmin totals + recent activity, and the dedicated audit-logs page)
 * and the in-flight Supabase adapter.
 *
 * Sibling seam pattern (see notifications-supa-seam.ts): the real adapter
 * lives at src/lib/supa/ on the merged tree, NOT on this branch, so adapter
 * resolution is a lazy require inside try/catch plus an injected-adapter
 * point for tests. A missing module, an unconfigured client, or the flag
 * being OFF all resolve to "no adapter" and callers keep Firestore
 * behavior exactly as today.
 *
 * CONTRACT (cluster-admin/PARITY_TABLE.md section 2, proven by the admin-6
 * harness supaAuditPage): the audit-logs page is ONE merged stream over
 * fs_audit_logs + fs_auditLogs with a total order
 *   timestamp desc, source (audit_logs before auditLogs), id asc,
 * an opaque cursor carrying (timestamp, id, source), 20 rows per page,
 * and actor/action filters applied POST-normalization to BOTH collections
 * (legacy rows normalize changedBy -> actorUid, userId -> target,
 * payload { oldRole, newRole }).
 *
 * DELIBERATE DIVERGENCE CORRECTIONS (pre-existing LIVE Firestore bugs;
 * the contract corrects them, this seam does NOT replicate them):
 *  (a) Page 1 is 20 merged rows. The Firestore page emits 25 rows on
 *      page 1 (per-collection limit(20) on unified + limit(20) on legacy,
 *      merged) — divergence "page-1 size" in the parity table.
 *  (b) Page 2 never re-emits legacy rows. The Firestore page applies ONE
 *      shared cursor (the last unified doc) to BOTH queries via
 *      startAfter, so legacy lg1..lg5 appear on page 1 AND page 2 —
 *      divergence "page-2 legacy duplication" in the parity table.
 * Both corrections are contract-mandated and pinned by tests in
 * src/lib/server/__tests__/admin-audit-supa.test.ts.
 *
 * Superadmin totals: totalUsers = fs_users count; totalAuditLogs =
 * fs_audit_logs count ONLY (the legacy auditLogs collection is never
 * counted, on either side). The superadmin recent-activity LIST stays
 * Firestore this wave (merge plan C-09); only its totals use this seam,
 * plus listSuperadminRecentSupa below for the seam-level contract
 * (first 50 fs_audit_logs rows, timestamp desc).
 */

/* ------------------------------------------------------------------ types */

export interface AdminAuditAdapter {
  listDocs(
    collectionPath: string,
    options?: {
      where?: Array<[string, string, unknown]>;
      orderBy?:
        | string
        | { field: string; direction?: 'asc' | 'desc' }
        | Array<{ field: string; direction?: 'asc' | 'desc' }>;
      limit?: number;
      startAfter?: string | number;
    },
  ): Promise<Array<{ id: string } & Record<string, unknown>>>;
  countDocs(
    collectionPath: string,
    where?: Array<[string, string, unknown]>,
  ): Promise<number>;
}

export type AuditSource = 'audit_logs' | 'auditLogs';

/** Canonical audit entry: the wire shape of /api/admin/audit-logs.
 *  Timestamps are ISO strings + millis — never Firestore Timestamps. */
export interface AuditEntry {
  id: string;
  source: AuditSource;
  actorUid: string;
  action: string;
  targetUidOrResource: string;
  payload?: unknown;
  timestamp: string | null;
  timestampMs: number;
}

export interface AuditCursor {
  tsMs: number;
  id: string;
  source: AuditSource;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  nextCursor: string | null;
}

/* --------------------------------------------------------------- flag gate */

/**
 * useSupa('admin-audit') equivalent. Mirrors src/lib/supa/flags.ts
 * semantics exactly (SUPA_SURFACES comma list, case-insensitive, '*'
 * enables everything, unset/empty = OFF) so this branch does not import a
 * module that does not exist here yet.
 */
export function adminAuditSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes('admin-audit');
}

/* -------------------------------------------------------- adapter plumbing */

let injectedAdapter: AdminAuditAdapter | null | undefined;

/** Test-only injection point (fake adapter over in-memory fixtures). */
export function setAdminAuditAdapterForTests(
  adapter: AdminAuditAdapter | null,
): void {
  injectedAdapter = adapter;
}

function resolveRealAdapter(): AdminAuditAdapter | null {
  try {
    // Lazy require so this branch compiles and runs before the adapter
    // branch lands. ONE-EDIT RE-POINT: these two module paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapterModule = require('@/lib/supa/adapter');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientModule = require('@/lib/supa/client');
    if (typeof clientModule?.getSupaClient !== 'function') return null;
    if (!clientModule.getSupaClient()) return null; // unconfigured
    if (typeof adapterModule?.getSupaAdapter !== 'function') return null;
    return adapterModule.getSupaAdapter() as AdminAuditAdapter;
  } catch {
    return null;
  }
}

/** The adapter when the surface is ON and Supabase is configured, else null. */
export function getAdminAuditAdapter(): AdminAuditAdapter | null {
  if (!adminAuditSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  return resolveRealAdapter();
}

/* ------------------------------------------------------------ timestamps */

/**
 * Milliseconds for any timestamp shape an adapter row can carry: ISO
 * strings (the storage ruling), numbers, Dates, SupaTimestamp values
 * (toMillis()/toDate()), and legacy dumped shapes
 * ({ _seconds, _nanoseconds } / { seconds, nanoseconds }). Mirrors the
 * adapter's exported timestampMillis semantics for these shapes.
 * Returns null when the value carries no usable time.
 */
export function auditTimestampMillis(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toMillis === 'function') {
      try {
        const ms = (v.toMillis as () => number).call(value);
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    const seconds =
      typeof v._seconds === 'number'
        ? v._seconds
        : typeof v.seconds === 'number'
          ? v.seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof v._nanoseconds === 'number'
          ? v._nanoseconds
          : typeof v.nanoseconds === 'number'
            ? v.nanoseconds
            : 0;
      return seconds * 1000 + Math.floor(nanos / 1_000_000);
    }
    if (typeof v.toDate === 'function') {
      try {
        const ms = (v.toDate as () => Date).call(value).getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* ----------------------------------------------------------- normalization */

type SupaRow = { id: string } & Record<string, unknown>;

function toEntry(
  row: SupaRow,
  source: AuditSource,
  actorUid: string,
  targetUidOrResource: string,
  payload: unknown,
): AuditEntry {
  const tsMs = auditTimestampMillis(row.timestamp) ?? 0;
  return {
    id: row.id,
    source,
    actorUid,
    action: typeof row.action === 'string' ? row.action : String(row.action ?? ''),
    targetUidOrResource,
    payload,
    timestamp: tsMs ? new Date(tsMs).toISOString() : null,
    timestampMs: tsMs,
  };
}

/** Unified audit_logs normalization (audit-logs/page.tsx unified map). */
export function normalizeUnifiedAuditRow(row: SupaRow): AuditEntry {
  return toEntry(
    row,
    'audit_logs',
    (row.actorUid as string) || (row.actor_uid as string) || '',
    (row.targetUidOrResource as string) || (row.target as string) || '',
    row.payload,
  );
}

/** Legacy auditLogs normalization: changedBy -> actorUid, userId ->
 *  target, payload rebuilt as { oldRole, newRole }. */
export function normalizeLegacyAuditRow(row: SupaRow): AuditEntry {
  return toEntry(
    row,
    'auditLogs',
    (row.changedBy as string) || '',
    (row.userId as string) || '',
    { oldRole: row.oldRole, newRole: row.newRole },
  );
}

/* --------------------------------------------------------- total ordering */

const SOURCE_RANK: Record<AuditSource, number> = { audit_logs: 0, auditLogs: 1 };

/** Contract total order: timestamp desc, source audit_logs before
 *  auditLogs, id asc. */
export function compareAuditEntries(a: AuditEntry, b: AuditEntry): number {
  if (b.timestampMs !== a.timestampMs) return b.timestampMs - a.timestampMs;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source])
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isAfterCursor(entry: AuditEntry, cursor: AuditCursor): boolean {
  if (entry.timestampMs !== cursor.tsMs) return entry.timestampMs < cursor.tsMs;
  const rank = SOURCE_RANK[entry.source];
  const cursorRank = SOURCE_RANK[cursor.source];
  if (rank !== cursorRank) return rank > cursorRank;
  return entry.id > cursor.id;
}

/* -------------------------------------------------------------- cursor io */

/** Opaque cursor: base64url of JSON { t: tsMs, i: id, s: source }. */
export function encodeAuditCursor(cursor: AuditCursor): string {
  const json = JSON.stringify({ t: cursor.tsMs, i: cursor.id, s: cursor.source });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeAuditCursor(raw: string): AuditCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed?.t !== 'number' ||
      typeof parsed?.i !== 'string' ||
      (parsed?.s !== 'audit_logs' && parsed?.s !== 'auditLogs')
    ) {
      return null;
    }
    return { tsMs: parsed.t, id: parsed.i, source: parsed.s };
  } catch {
    return null;
  }
}

function coerceCursor(
  cursor: string | AuditCursor | null | undefined,
): AuditCursor | null {
  if (!cursor) return null;
  if (typeof cursor === 'string') return decodeAuditCursor(cursor);
  return cursor;
}

/* --------------------------------------------------------------- queries */

export async function getAuditTotalsSupa(
  adapter: AdminAuditAdapter,
): Promise<{ totalUsers: number; totalAuditLogs: number }> {
  const [totalUsers, totalAuditLogs] = await Promise.all([
    adapter.countDocs('users'),
    // audit_logs ONLY — the legacy auditLogs collection is never counted
    // in the superadmin total, on either side (parity table section 2).
    adapter.countDocs('audit_logs'),
  ]);
  return { totalUsers, totalAuditLogs };
}

/** Superadmin recent activity: first 50 fs_audit_logs rows, timestamp
 *  desc (superadmin/page.tsx AUDIT_LOG_PAGE_SIZE = 50). */
export async function listSuperadminRecentSupa(
  adapter: AdminAuditAdapter,
): Promise<AuditEntry[]> {
  const rows = await adapter.listDocs('audit_logs', {
    orderBy: { field: 'timestamp', direction: 'desc' },
    limit: 50,
  });
  return rows
    .map(normalizeUnifiedAuditRow)
    .sort(compareAuditEntries)
    .slice(0, 50);
}

/**
 * The contract merged-stream page over fs_audit_logs + fs_auditLogs.
 *
 * Divergence correction (a): exactly pageSize (default 20) merged rows
 * per page — NOT the Firestore page's 25 (20 unified + 5 legacy from
 * per-collection limits).
 * Divergence correction (b): the opaque (timestamp, id, source) cursor
 * positions the reader in the ONE merged stream, so page 2 continues
 * where page 1 ended with zero overlap and zero skip — the Firestore
 * page's shared unified cursor re-emits every legacy row on page 2.
 */
export async function listAuditPageSupa(
  adapter: AdminAuditAdapter,
  opts: {
    actor?: string;
    action?: string;
    cursor?: string | AuditCursor | null;
    pageSize?: number;
  } = {},
): Promise<AuditPage> {
  const [unifiedRows, legacyRows] = await Promise.all([
    adapter.listDocs('audit_logs'),
    adapter.listDocs('auditLogs'),
  ]);
  let all: AuditEntry[] = [
    ...unifiedRows.map(normalizeUnifiedAuditRow),
    ...legacyRows.map(normalizeLegacyAuditRow),
  ];
  // Filters apply post-normalization to BOTH collections: the actor
  // filter matches unified actorUid and legacy changedBy alike because
  // both have already been normalized to actorUid.
  if (opts.actor) all = all.filter((x) => x.actorUid === opts.actor);
  if (opts.action) all = all.filter((x) => x.action === opts.action);
  all.sort(compareAuditEntries);

  const cursor = coerceCursor(opts.cursor);
  let start = 0;
  if (cursor) {
    const idx = all.findIndex((x) => isAfterCursor(x, cursor));
    start = idx === -1 ? all.length : idx;
  }
  const pageSize = opts.pageSize ?? 20;
  const entries = all.slice(start, start + pageSize);
  const last = entries[entries.length - 1];
  return {
    entries,
    total: all.length,
    nextCursor:
      last && start + pageSize < all.length
        ? encodeAuditCursor({
            tsMs: last.timestampMs,
            id: last.id,
            source: last.source,
          })
        : null,
  };
}

/** Sorted unique actions from the latest 200 rows of EACH collection
 *  (audit-logs/page.tsx fetchAvailableActions). */
export async function listAuditActionsSupa(
  adapter: AdminAuditAdapter,
): Promise<string[]> {
  const perCollection = { orderBy: { field: 'timestamp', direction: 'desc' as const }, limit: 200 };
  const [unifiedRows, legacyRows] = await Promise.all([
    adapter.listDocs('audit_logs', perCollection),
    adapter.listDocs('auditLogs', perCollection),
  ]);
  const actions = new Set<string>();
  for (const row of [...unifiedRows, ...legacyRows]) {
    if (typeof row.action === 'string' && row.action) actions.add(row.action);
  }
  return Array.from(actions).sort();
}
