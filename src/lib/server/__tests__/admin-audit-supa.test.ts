/**
 * admin-audit-supa.test.ts — seam tests for the ADMIN AUDIT surface group
 * (admin-2). Drives the REAL functions in ../admin-audit-supa.ts with a
 * fake adapter over the copied admin-6 parity fixtures (in-memory only,
 * zero live reads). Expected values are the Supa CONTRACT column of
 * cluster-admin/PARITY_TABLE.md section 2.
 *
 * Two expectations here are DELIBERATE DIVERGENCE CORRECTIONS of live
 * Firestore bugs, contract-mandated by the parity table:
 *  (a) page-1 size: the contract page 1 has 20 merged rows; the live
 *      Firestore page emits 25 (per-collection limit(20) x2, merged).
 *  (b) page-2 legacy duplication: the contract page 2 has zero overlap
 *      with page 1; the live Firestore page re-emits legacy lg1..lg5 on
 *      page 2 because one shared unified cursor is startAfter-applied
 *      to the legacy query too.
 */
import {
  AUDIT_UNIFIED,
  AUDIT_LEGACY,
  AUDIT_TIE_UNIFIED,
  AUDIT_TIE_LEGACY,
  DASH_USERS,
  NOW_MS,
  TIE_MS,
  ts,
  toJsonbAll,
  type FDoc,
} from './admin-audit-fixtures';
import {
  getAuditTotalsSupa,
  listSuperadminRecentSupa,
  listAuditPageSupa,
  listAuditActionsSupa,
  decodeAuditCursor,
  auditTimestampMillis,
  type AdminAuditAdapter,
} from '../admin-audit-supa';

/** Fake adapter: rows are the adapter's read shape { id, ...data } with
 *  jsonb (ISO-string) timestamps, exactly as the real adapter returns. */
function fakeAdapter(collections: Record<string, FDoc[]>): AdminAuditAdapter {
  const rowsOf = (name: string) =>
    toJsonbAll(collections[name] ?? []).map(
      (d) => ({ id: d.id, ...d.data }) as { id: string } & Record<string, unknown>,
    );
  return {
    async listDocs(collectionPath, options) {
      let rows = rowsOf(collectionPath);
      const orderBy = options?.orderBy;
      const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (order && typeof order === 'object' && order.field === 'timestamp') {
        rows = [...rows].sort(
          (a, b) =>
            (auditTimestampMillis(b.timestamp) ?? 0) -
            (auditTimestampMillis(a.timestamp) ?? 0),
        );
        if (order.direction === 'asc') rows.reverse();
      }
      if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
      return rows;
    },
    async countDocs(collectionPath, where) {
      let rows = rowsOf(collectionPath);
      for (const [field, , value] of where ?? []) {
        rows = rows.filter((r) => String((r as any)[field]) === String(value));
      }
      return rows.length;
    },
  };
}

const auditAdapter = () =>
  fakeAdapter({
    users: DASH_USERS,
    audit_logs: AUDIT_UNIFIED,
    auditLogs: AUDIT_LEGACY,
  });

describe('getAuditTotalsSupa (superadmin overview)', () => {
  it('totalUsers = fs_users count (6); totalAuditLogs = fs_audit_logs ONLY (30, legacy 5 excluded)', async () => {
    await expect(getAuditTotalsSupa(auditAdapter())).resolves.toEqual({
      totalUsers: 6,
      totalAuditLogs: 30,
    });
  });
});

describe('listSuperadminRecentSupa', () => {
  it('first page is timestamp desc, au01 first, all 30 fixture rows (page size 50)', async () => {
    const rows = await listSuperadminRecentSupa(auditAdapter());
    expect(rows).toHaveLength(30);
    expect(rows[0].id).toBe('au01');
    expect(rows.every((r) => r.source === 'audit_logs')).toBe(true);
    const ms = rows.map((r) => r.timestampMs);
    expect([...ms].sort((a, b) => b - a)).toEqual(ms);
  });

  it('caps at 50 rows when more exist', async () => {
    const many: FDoc[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${String(i).padStart(2, '0')}`,
      data: {
        actorUid: 'actor-1',
        action: 'login',
        timestamp: ts(NOW_MS - i * 60_000),
      },
    }));
    const rows = await listSuperadminRecentSupa(fakeAdapter({ audit_logs: many }));
    expect(rows).toHaveLength(50);
    expect(rows[0].id).toBe('m00');
  });
});

describe('listAuditPageSupa — contract merged stream', () => {
  it('DIVERGENCE CORRECTION (a) page-1 size: page 1 = 20 merged rows (Firestore live page emits 25)', async () => {
    const p1 = await listAuditPageSupa(auditAdapter(), {});
    expect(p1.entries).toHaveLength(20);
    expect(p1.total).toBe(35);
    expect(typeof p1.nextCursor).toBe('string'); // opaque
  });

  it('DIVERGENCE CORRECTION (b) page-2 legacy duplication: page 2 = remaining 15, zero overlap, zero skip', async () => {
    const adapter = auditAdapter();
    const p1 = await listAuditPageSupa(adapter, {});
    const p2 = await listAuditPageSupa(adapter, { cursor: p1.nextCursor });
    expect(p2.entries).toHaveLength(15);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.entries, ...p2.entries].map((x) => x.id);
    expect(new Set(ids).size).toBe(35);
    // Specifically: no legacy row from page 1 reappears on page 2.
    const p1Legacy = new Set(
      p1.entries.filter((x) => x.source === 'auditLogs').map((x) => x.id),
    );
    expect(p2.entries.filter((x) => p1Legacy.has(x.id))).toHaveLength(0);
  });

  it('cursor is opaque and round-trips (timestamp, id, source)', async () => {
    const p1 = await listAuditPageSupa(auditAdapter(), {});
    const last = p1.entries[p1.entries.length - 1];
    expect(decodeAuditCursor(p1.nextCursor!)).toEqual({
      tsMs: last.timestampMs,
      id: last.id,
      source: last.source,
    });
  });

  it('tie cluster: 26 rows over pages, no dup/skip, total order holds at identical timestamps', async () => {
    const adapter = fakeAdapter({
      audit_logs: AUDIT_TIE_UNIFIED,
      auditLogs: AUDIT_TIE_LEGACY,
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let p = 0; p < 5; p++) {
      const r = await listAuditPageSupa(adapter, { cursor });
      ids.push(...r.entries.map((x) => x.id));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(26);
    expect(new Set(ids).size).toBe(26);
    // Tie rows: unified (audit_logs) before legacy (auditLogs), id asc.
    const tieIds = ids.filter((id) => id.startsWith('tie-'));
    expect(tieIds).toEqual([
      'tie-u1', 'tie-u2', 'tie-u3', 'tie-u4', 'tie-u5',
      'tie-l1', 'tie-l2', 'tie-l3',
    ]);
    const all = await listAuditPageSupa(adapter, { pageSize: 100 });
    expect(
      all.entries.filter((x) => x.id.startsWith('tie-')).every((x) => x.timestampMs === TIE_MS),
    ).toBe(true);
  });

  it('actor filter applies post-normalization to BOTH collections: 20 = 15 unified + 5 legacy', async () => {
    const r = await listAuditPageSupa(auditAdapter(), { actor: 'actor-1', pageSize: 100 });
    expect(r.total).toBe(20);
    expect(r.entries.filter((x) => x.source === 'audit_logs')).toHaveLength(15);
    expect(r.entries.filter((x) => x.source === 'auditLogs')).toHaveLength(5);
  });

  it('action filter role_changed: 5 rows, all from legacy auditLogs', async () => {
    const r = await listAuditPageSupa(auditAdapter(), { action: 'role_changed', pageSize: 100 });
    expect(r.total).toBe(5);
    expect(r.entries.every((x) => x.source === 'auditLogs')).toBe(true);
  });

  it('legacy normalization identity: lg1 changedBy->actorUid, userId->target, payload {oldRole,newRole}', async () => {
    const r = await listAuditPageSupa(auditAdapter(), { action: 'role_changed', pageSize: 100 });
    const lg1 = r.entries.find((x) => x.id === 'lg1')!;
    expect(lg1.actorUid).toBe('actor-1');
    expect(lg1.targetUidOrResource).toBe('u1');
    expect(lg1.payload).toEqual({ oldRole: 'member', newRole: 'admin' });
    expect(typeof lg1.timestamp).toBe('string');
    expect(lg1.timestampMs).toBe(NOW_MS - 40 * 3_600_000);
  });
});

describe('listAuditActionsSupa', () => {
  it('sorted unique actions from latest 200 per collection', async () => {
    await expect(listAuditActionsSupa(auditAdapter())).resolves.toEqual([
      'login',
      'role_assigned',
      'role_changed',
    ]);
  });
});
