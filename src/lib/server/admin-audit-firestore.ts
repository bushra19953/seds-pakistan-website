/**
 * admin-audit-firestore — HOTFIX (fix/supa-read-fallback).
 *
 * A Firestore-backed implementation of the admin-audit seam's
 * AdminAuditAdapter, so GET /api/admin/audit-logs can serve the
 * surface's Firestore read when the Supabase read throws or comes
 * back empty. The seam functions in admin-audit-supa.ts
 * (listAuditPageSupa, getAuditTotalsSupa, listAuditActionsSupa,
 * listSuperadminRecentSupa) run unchanged over this adapter, so the
 * merged-stream contract (total order, cursor, legacy normalization)
 * is identical on the fallback path.
 *
 * Why the fallback exists: the seam reads fs_audit_logs +
 * fs_auditLogs through the Supabase adapter, but the migration DDL
 * folded the legacy table's name to lowercase (fs_auditlogs), so the
 * adapter's fs_auditLogs lookup throws PGRST205 and the flipped page
 * answered 500 while Firestore held the complete history.
 *
 * Reads are whole-collection gets finished in memory: the audit
 * collections are the same ones the pre-migration page read directly,
 * and this path runs only while the Supabase read is broken.
 */

import type { AdminAuditAdapter } from './admin-audit-supa';

type WhereClause = [string, string, unknown];
type OrderSpec = { field: string; direction?: 'asc' | 'desc' };

interface FirestoreLike {
  collection(
    name: string,
  ): {
    get(): Promise<{
      docs: Array<{ id: string; data(): Record<string, any> }>;
      size?: number;
    }>;
    count?: () => {
      get(): Promise<{ data(): { count: number } }>;
    };
  };
}

/** Milliseconds for any timestamp shape a Firestore row can carry. */
function valueMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
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
  }
  return null;
}

function compareValues(a: unknown, b: unknown): number {
  const ma = valueMillis(a);
  const mb = valueMillis(b);
  if (ma !== null && mb !== null) return ma < mb ? -1 : ma > mb ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchesWhere(
  row: Record<string, unknown>,
  clause: WhereClause,
): boolean {
  const [field, op, value] = clause;
  const actual = row[field];
  if (op === 'in') {
    return Array.isArray(value) && value.some((v) => compareValues(actual, v) === 0);
  }
  const c = compareValues(actual, value);
  switch (op) {
    case '==':
      return c === 0;
    case '!=':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    default:
      return false;
  }
}

export function createFirestoreAuditAdapter(
  db: FirestoreLike,
): AdminAuditAdapter {
  return {
    async listDocs(collectionPath, options) {
      const snap = await db.collection(collectionPath).get();
      let rows: Array<{ id: string } & Record<string, unknown>> = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() ?? {}) }),
      );
      for (const clause of (options?.where ?? []) as WhereClause[]) {
        rows = rows.filter((r) => matchesWhere(r, clause));
      }
      const orders: OrderSpec[] = options?.orderBy
        ? Array.isArray(options.orderBy)
          ? (options.orderBy as OrderSpec[])
          : typeof options.orderBy === 'string'
            ? [{ field: options.orderBy, direction: 'asc' }]
            : [options.orderBy as OrderSpec]
        : [];
      for (const order of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const c = compareValues(a[order.field], b[order.field]);
          return order.direction === 'desc' ? -c : c;
        });
      }
      if (options?.startAfter !== undefined) {
        // The seam never passes startAfter (its page cursor is
        // applied post-normalization); support the id form for
        // completeness.
        const idx = rows.findIndex((r) => r.id === String(options.startAfter));
        if (idx >= 0) rows = rows.slice(idx + 1);
      }
      if (typeof options?.limit === 'number') {
        rows = rows.slice(0, options.limit);
      }
      return rows;
    },

    async countDocs(collectionPath, where) {
      if (where && where.length > 0) {
        return (await this.listDocs(collectionPath, { where })).length;
      }
      const col = db.collection(collectionPath);
      if (typeof col.count === 'function') {
        const agg = await col.count().get();
        return agg.data().count;
      }
      const snap = await col.get();
      return snap.size ?? snap.docs.length;
    },
  };
}
