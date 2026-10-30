/**
 * One-time fs_events resync for the events mirror-staleness fix
 * (2026-10-28).
 *
 * WHY THIS EXISTS: fs_events was populated by a single bulk dump
 * (every row carries the same migrated_at, 2026-10-25T15:34:02Z).
 * Mirror-on-write for event docs only exists since the WS10 server
 * write routes; writes made before they went live — including the
 * EV2 test events' soft-deletes (Firestore deleted:true /
 * status:'archived' on 2026-10-26, executed while the live build
 * still wrote client-direct with no mirror anywhere) — never
 * reached the mirror, and nothing ever reconciled the two stores.
 * The public /events page prefers fs_events rows, so the deleted
 * test events rendered publicly. Mirror-on-write is now in place on
 * every event write route; this resync repairs the accumulated
 * drift once, from the primary.
 *
 * WHAT IT DOES: Firestore is primary. For every Firestore events
 * doc, the fs_events row must equal the doc serialized through the
 * seam's own serializer (toSupaSerializable — the exact shape the
 * mirror helpers store). The dry-run (DEFAULT) only reports:
 * per-doc field-level diffs for drifted rows, missing rows, and
 * orphan mirror rows (present in fs_events, absent in Firestore).
 * Repair mode rewrites drifted/missing rows with adapter.setDoc
 * (full-doc replace, the resync end state: every fs_events row
 * equals its Firestore source) and deletes orphan rows. Reaching
 * the end state only writes where drift exists; in-sync rows are
 * not rewritten.
 *
 * The adapter comes from the seam's resolveEventsAdapter(), so the
 * resync runs only when the events surface is enabled and Supabase
 * is configured — the same gate as every other events mirror path.
 * It reuses the existing mirror machinery (adapter + serializer);
 * there is no parallel write path here.
 *
 * READ BUDGET (cron shelter, census 20 row 7): the production
 * runner's Firestore scan is capped at EVENTS_RESYNC_READ_BUDGET_CAP
 * via the applications guard's limit(cap+1) tripwire — over the cap
 * it reports overBudget and performs zero writes (it does not even
 * list the mirror). See runEventsResync below.
 */

import {
  resolveEventsAdapter,
  toSupaSerializable,
  type EventsSupaAdapter,
} from './server-events';

/* ------------------------------------------------------------------ types */

export interface EventSourceDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface EventFieldDiff {
  field: string;
  /** Current mirror value (canonicalized); undefined = absent in the mirror. */
  from: unknown;
  /** Firestore source value (canonicalized); undefined = absent in the source. */
  to: unknown;
}

export interface EventsResyncApplied {
  id: string;
  action: 'upsert' | 'delete-orphan';
  ok: boolean;
  error?: string;
}

export interface EventsResyncReport {
  mode: 'dry-run' | 'repair';
  /**
   * True when the Firestore scan tripped the read-budget cap
   * (EVENTS_RESYNC_READ_BUDGET_CAP): the report is the tripwire
   * signal only — the mirror was not even listed, and ZERO writes
   * happened in either mode. Ported from the applications guard
   * (src/lib/applications-resync.ts), census 20 row 7.
   */
  overBudget: boolean;
  /** Firestore reads consumed by the source scan (the capped query's snapshot size). */
  readsUsed: number;
  totalSource: number;
  totalMirror: number;
  inSync: string[];
  drifted: Array<{ id: string; diffs: EventFieldDiff[] }>;
  missing: string[];
  orphans: string[];
  /** Empty in dry-run mode: a dry run performs zero writes. */
  applied: EventsResyncApplied[];
}

/* ------------------------------------------------------------ canonicalize */

/**
 * Canonical plain-JSON form of a doc body: the seam serializer turns
 * Timestamps / Dates / FieldValue sentinels into ISO strings and
 * drops undefined, so a Firestore Admin doc body and an adapter-read
 * mirror body land in the same shape and can be compared value by
 * value.
 */
export function canonicalEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return (toSupaSerializable(data) ?? {}) as Record<string, unknown>;
}

/** Stable stringify (object keys sorted) for value equality. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
}

/** Top-level field diffs between a canonical source doc and a canonical mirror doc. */
export function diffEventDocs(
  source: Record<string, unknown>,
  mirror: Record<string, unknown>,
): EventFieldDiff[] {
  const fields = new Set([...Object.keys(source), ...Object.keys(mirror)]);
  const diffs: EventFieldDiff[] = [];
  for (const field of [...fields].sort()) {
    const from = mirror[field];
    const to = source[field];
    if (canonicalJson(from) !== canonicalJson(to)) {
      diffs.push({ field, from, to });
    }
  }
  return diffs;
}

/* ------------------------------------------------------------------- core */

export async function resyncEventsMirror(deps: {
  source: EventSourceDoc[];
  adapter: EventsSupaAdapter;
  mode: 'dry-run' | 'repair';
}): Promise<EventsResyncReport> {
  const { source, adapter, mode } = deps;
  const rows = await adapter.listDocs('events', {});
  const mirrorById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const rec = row as { id: string } & Record<string, unknown>;
    mirrorById.set(rec.id, rec);
  }

  const report: EventsResyncReport = {
    mode,
    overBudget: false,
    readsUsed: source.length,
    totalSource: source.length,
    totalMirror: rows.length,
    inSync: [],
    drifted: [],
    missing: [],
    orphans: [],
    applied: [],
  };

  const sourceIds = new Set<string>();
  for (const doc of source) {
    sourceIds.add(doc.id);
    const sourceCanon = canonicalEventData(doc.data);
    const mirrorRow = mirrorById.get(doc.id);
    if (!mirrorRow) {
      report.missing.push(doc.id);
      continue;
    }
    // The adapter returns { id, ...data } (a stored `id` field inside
    // the jsonb, when present, is the same value). When the source
    // doc body carries no `id` field of its own, the row id is
    // addressing, not content — exclude it from the comparison.
    const mirrorCanon = canonicalEventData(mirrorRow);
    if (!('id' in sourceCanon)) delete mirrorCanon.id;
    const diffs = diffEventDocs(sourceCanon, mirrorCanon);
    if (diffs.length === 0) report.inSync.push(doc.id);
    else report.drifted.push({ id: doc.id, diffs });
  }
  for (const id of mirrorById.keys()) {
    if (!sourceIds.has(id)) report.orphans.push(id);
  }

  if (mode === 'repair') {
    const sourceById = new Map(source.map((d) => [d.id, d]));
    const upsertIds = [
      ...report.missing,
      ...report.drifted.map((d) => d.id),
    ];
    for (const id of upsertIds) {
      const doc = sourceById.get(id);
      if (!doc) continue;
      try {
        await adapter.setDoc(
          'events',
          id,
          toSupaSerializable(doc.data) as Record<string, unknown>,
        );
        report.applied.push({ id, action: 'upsert', ok: true });
      } catch (err) {
        report.applied.push({
          id,
          action: 'upsert',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const id of report.orphans) {
      try {
        await adapter.deleteDoc('events', id);
        report.applied.push({ id, action: 'delete-orphan', ok: true });
      } catch (err) {
        report.applied.push({
          id,
          action: 'delete-orphan',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return report;
}

/* ------------------------------------------------------- production wiring */

/**
 * Read-budget cap for the source scan (cron shelter, census 20 row 7 —
 * the applications guard's pattern, APPLICATIONS_RESYNC_READ_BUDGET_CAP
 * = 300 there). The scan asks for cap + 1 docs; if the +1 exists the
 * collection is over budget and the runner reports overBudget WITHOUT
 * listing the mirror or writing anything — a future census-grade pass
 * needs its own budget decision, it does not happen by accident here.
 * Events number <100 today, so the cap is headroom, not a constraint.
 */
export const EVENTS_RESYNC_READ_BUDGET_CAP = 300;

/** Firestore rows are fetched in one capped query: cap + 1 as the tripwire. */
const SCAN_LIMIT = EVENTS_RESYNC_READ_BUDGET_CAP + 1;

/**
 * Run the resync against the live stores. `db` is the Firestore
 * Admin database (structurally typed so tests can fake it). Returns
 * null when the events adapter is unavailable (surface off /
 * Supabase unconfigured) — the caller answers 503, mirroring the
 * /api/events/public convention.
 */
export async function runEventsResync(
  db: {
    collection: (name: string) => {
      limit: (n: number) => {
        get: () => Promise<{
          size: number;
          docs: Array<{ id: string; data: () => Record<string, unknown> }>;
        }>;
      };
    };
  },
  mode: 'dry-run' | 'repair',
): Promise<EventsResyncReport | null> {
  const adapter = await resolveEventsAdapter();
  if (!adapter) return null;
  const snap = await db.collection('events').limit(SCAN_LIMIT).get();
  const readsUsed = snap.size;
  if (snap.size > EVENTS_RESYNC_READ_BUDGET_CAP) {
    return {
      mode,
      overBudget: true,
      readsUsed,
      totalSource: readsUsed,
      totalMirror: 0,
      inSync: [],
      drifted: [],
      missing: [],
      orphans: [],
      applied: [],
    };
  }
  const source: EventSourceDoc[] = snap.docs.map((d) => ({
    id: d.id,
    data: d.data() as Record<string, unknown>,
  }));
  const report = await resyncEventsMirror({ source, adapter, mode });
  return { ...report, readsUsed };
}
