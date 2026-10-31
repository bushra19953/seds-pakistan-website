/**
 * fs_timeline resync: one-time bootstrap + daily-guard repair
 * (2026-11-01; pattern: src/lib/supa-events/resync-events.ts).
 *
 * WHY THIS EXISTS: fs_timeline was created by the bulk migration DDL
 * but only ever received 2 rows from the 2026-10-25 dump, while the
 * Firestore collection holds 38 docs — and until mirror-on-write
 * landed in /api/admin/pages/write (mirror-timeline.ts), no timeline
 * write ever reached the mirror. The public read seam
 * (public-timeline.ts) serves fs_timeline, so the mirror must equal
 * the source before the surface flips, and must stay equal after.
 *
 * WHAT IT DOES: Firestore is primary. For every Firestore timeline
 * doc, the fs_timeline row must equal the doc serialized through the
 * events seam's serializer (toSupaSerializable — the exact shape the
 * mirror helper stores). The dry-run (DEFAULT) only reports: missing
 * rows, per-doc drifted field names, and orphan mirror rows (present
 * in fs_timeline, absent in Firestore). Repair mode rewrites
 * drifted/missing rows with adapter.setDoc (full-doc replace) and
 * deletes orphan rows. In-sync rows are not rewritten.
 *
 * READ BUDGET: the Firestore scan is capped at
 * TIMELINE_RESYNC_READ_BUDGET_CAP via a limit(cap+1) tripwire — over
 * the cap it reports overBudget and performs zero writes (it does
 * not even list the mirror). The collection holds 38 docs today;
 * the cap is a runaway guard, not an expected bound.
 *
 * The adapter comes from resolveTimelineAdapter(), so the resync
 * runs only when the 'timeline' surface is enabled and Supabase is
 * configured — the same gate as every other timeline mirror path.
 */

import { normalizeSupaData, resolveTimelineAdapter, TIMELINE_COLLECTION_PATH } from './public-timeline';
import { toSupaSerializable } from '@/lib/supa-events/server-events';

export const TIMELINE_RESYNC_READ_BUDGET_CAP = 500;

export interface TimelineFieldDrift {
  id: string;
  fields: string[];
}

export interface TimelineResyncReport {
  unavailable?: boolean;
  overBudget?: boolean;
  mode: 'dry-run' | 'repair';
  sourceCount: number;
  mirrorCount: number;
  missing: string[];
  drifted: TimelineFieldDrift[];
  orphans: string[];
  repaired?: { upserted: number; deleted: number };
  /** Per-doc repair failures, captured without aborting the run. */
  failures?: Array<{ id: string; op: 'set' | 'delete'; error: string }>;
}

/** Minimal structural slice of the Admin Firestore API the resync uses. */
export interface TimelineResyncDb {
  collection(name: string): {
    limit(n: number): {
      get(): Promise<{ size: number; docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
    };
  };
}

/** Canonical form for comparison: serializer output with sorted keys. */
function canon(value: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v !== null && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec).sort()) out[k] = sortDeep(rec[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

/** Source doc -> the exact stored shape the mirror helper writes. */
function sourceShape(data: Record<string, unknown>): Record<string, unknown> {
  return toSupaSerializable(data) as Record<string, unknown>;
}

/** Mirror row (adapter shape: id + data fields) -> comparable shape. */
function mirrorShape(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...data } = row;
  void _id;
  // Rows can carry pre-seam dump shapes ({seconds,nanoseconds});
  // normalizeSupaData turns timestamp-likes into toDate() objects and
  // the serializer turns them back into ISO strings, so both sides
  // meet at the serializer's canonical output.
  return toSupaSerializable(normalizeSupaData(data)) as Record<string, unknown>;
}

function driftedFields(source: Record<string, unknown>, mirror: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(source), ...Object.keys(mirror)]);
  const out: string[] = [];
  for (const k of keys) {
    if (canon(source[k]) !== canon(mirror[k])) out.push(k);
  }
  return out.sort();
}

export async function runTimelineResync(
  db: TimelineResyncDb,
  options: { mode?: 'dry-run' | 'repair' } = {},
): Promise<TimelineResyncReport> {
  const mode = options.mode === 'repair' ? 'repair' : 'dry-run';
  const base: TimelineResyncReport = {
    mode,
    sourceCount: 0,
    mirrorCount: 0,
    missing: [],
    drifted: [],
    orphans: [],
  };

  const adapter = resolveTimelineAdapter();
  if (!adapter) return { ...base, unavailable: true };

  const snap = await db
    .collection(TIMELINE_COLLECTION_PATH)
    .limit(TIMELINE_RESYNC_READ_BUDGET_CAP + 1)
    .get();
  if (snap.size > TIMELINE_RESYNC_READ_BUDGET_CAP) {
    return { ...base, overBudget: true, sourceCount: snap.size };
  }
  base.sourceCount = snap.size;

  const mirrorRows = await adapter.listDocs(TIMELINE_COLLECTION_PATH, {
    limit: TIMELINE_RESYNC_READ_BUDGET_CAP + 1,
  });
  base.mirrorCount = mirrorRows.length;
  const mirrorById = new Map<string, Record<string, unknown>>();
  for (const row of mirrorRows) {
    if (typeof row.id === 'string') mirrorById.set(row.id, row);
  }

  const sourceIds = new Set<string>();
  for (const doc of snap.docs) {
    sourceIds.add(doc.id);
    const shape = sourceShape(doc.data());
    const mirror = mirrorById.get(doc.id);
    if (!mirror) {
      base.missing.push(doc.id);
      continue;
    }
    const fields = driftedFields(shape, mirrorShape(mirror));
    if (fields.length > 0) base.drifted.push({ id: doc.id, fields });
  }
  for (const id of mirrorById.keys()) {
    if (!sourceIds.has(id)) base.orphans.push(id);
  }
  base.missing.sort();
  base.orphans.sort();
  base.drifted.sort((a, b) => a.id.localeCompare(b.id));

  if (mode === 'repair') {
    let upserted = 0;
    let deleted = 0;
    const failures: Array<{ id: string; op: 'set' | 'delete'; error: string }> = [];
    const sourceById = new Map(snap.docs.map((d) => [d.id, d.data()]));
    for (const id of [...base.missing, ...base.drifted.map((d) => d.id)]) {
      const data = sourceById.get(id);
      if (!data) continue;
      try {
        await adapter.setDoc(TIMELINE_COLLECTION_PATH, id, sourceShape(data));
        upserted++;
      } catch (err) {
        failures.push({ id, op: 'set', error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const id of base.orphans) {
      try {
        await adapter.deleteDoc(TIMELINE_COLLECTION_PATH, id);
        deleted++;
      } catch (err) {
        failures.push({ id, op: 'delete', error: err instanceof Error ? err.message : String(err) });
      }
    }
    base.repaired = { upserted, deleted };
    if (failures.length > 0) base.failures = failures;
  }

  return base;
}
