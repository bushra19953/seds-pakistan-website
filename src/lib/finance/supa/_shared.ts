/**
 * MIGRATION SEAM: finance shared seam infrastructure.
 *
 * Supabase migration — FINANCE cluster (Cluster M, finance half).
 * Plans: ~/workspace/supabase-migration/finance/PLAN_FG123.md §0.2 (pinned
 * seam mechanism), PLAN_FG45.md, MANUAL_LIST.md. Merge plan step 12.
 *
 * Every finance seam module (lib-core, routes-core, ledger-receipts,
 * money-approvals, reconciliations) builds on this file. It is the ONLY
 * finance module that imports the adapter (`@/lib/supa`, copied
 * byte-identical from feat/supa-adapter @787bad9; never edited here).
 *
 * Contracts (PLAN_FG123 §0.2, as adapted to the landed adapter):
 * - Flag gate per export: adapter present (getSupaClient() != null) AND
 *   useSupa('<surface-key>') — SUPA_SURFACES semantics from the adapter's
 *   flags.ts (comma-separated, case-insensitive, trimmed, '*' = all,
 *   unset = all OFF). No other flag spelling exists in this cluster.
 *   FINANCE_MAKER_CHECKER_ENFORCED (src/lib/finance/flags.ts) is finance
 *   LAW and is never conflated with SUPA_SURFACES.
 * - Fallback: flag OFF, adapter unconfigured, or ANY adapter error ->
 *   the caller's existing Firestore code path runs byte-identically.
 *   runSupaRead implements this; write mirrors NEVER throw.
 * - Dual-write: for migrated writes, Firestore executes first and stays
 *   authoritative; the mirror follows via the adapter; mirror failure is
 *   swallowed and logged, never audited, never surfaced. MANUAL_LIST
 *   writes (money-approval create/decide/expire, reconciliation complete)
 *   get NO mirror in this phase (PLAN_FG45 §1.4 / FG5 W3 rule).
 * - Timestamps: jsonb timestamp fields arrive as ISO strings, or are
 *   rehydrated by the adapter into SupaTimestamp objects (which have NO
 *   toJSON — JSON.stringify would leak {_seconds,_nanoseconds}, unlike a
 *   Firestore Timestamp which serializes to ISO). The seam normalizes
 *   every known finance timestamp field to an ISO string before any
 *   consumer or response sees the row (financeSupaTimestamp).
 */

import { getSupaAdapter, getSupaClient, useSupa, type SupaAdapter, type SupaDoc } from '@/lib/supa';

export type FinanceSupaPort = SupaAdapter;
export type { SupaDoc };

/* ------------------------------------------------------------------ flags */

let enabledOverride: boolean | undefined;
let portOverride: FinanceSupaPort | null | undefined;

/** Test-only: force every finance surface gate on/off. */
export function __setFinanceSupaEnabledForTests(v: boolean | undefined): void {
  enabledOverride = v;
}

/** Test-only: inject a fake adapter port (null = unconfigured). */
export function __setFinanceSupaPortForTests(p: FinanceSupaPort | null | undefined): void {
  portOverride = p;
}

export function financeSupaSurfaceEnabled(surface: string): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  try {
    return useSupa(surface);
  } catch {
    return false;
  }
}

/** The adapter port when the surface gate can serve, else null. */
export function financeSupaPort(surface: string): FinanceSupaPort | null {
  if (!financeSupaSurfaceEnabled(surface)) return null;
  if (portOverride !== undefined) return portOverride;
  try {
    if (!getSupaClient()) return null;
    return getSupaAdapter();
  } catch {
    return null;
  }
}

/**
 * Run a Supabase read for `surface`; on gate-off or ANY error, run the
 * Firestore fallback instead. This is the fallback contract (§0.2.5).
 */
export async function runSupaRead<T>(
  surface: string,
  read: (port: FinanceSupaPort) => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const port = financeSupaPort(surface);
  if (!port) return fallback();
  try {
    return await read(port);
  } catch (err) {
    console.error(`[finance-supa] ${surface} read failed; falling back to Firestore`, err);
    return fallback();
  }
}

/* ------------------------------------------------------------- timestamps */

/**
 * Normalize any stored timestamp representation to an ISO string.
 * Accepts: ISO/Date-parseable strings, epoch numbers, Date instances,
 * Timestamp-like objects (toDate()/toMillis()), SupaTimestamp, and the
 * Admin-SDK dump shapes { _seconds, _nanoseconds } / { seconds,
 * nanoseconds }. Returns null for null/undefined/unparseable values.
 */
export function financeSupaTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === 'string') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (typeof value === 'number') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value.toISOString();
    }
    const t = value as {
      toDate?: () => Date;
      toMillis?: () => number;
      _seconds?: number;
      seconds?: number;
      _nanoseconds?: number;
      nanoseconds?: number;
    };
    if (typeof t.toDate === 'function') {
      const d = t.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;
    }
    if (typeof t.toMillis === 'function') {
      const d = new Date(t.toMillis());
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    const seconds = t._seconds ?? t.seconds;
    if (typeof seconds === 'number') {
      const nanos = t._nanoseconds ?? t.nanoseconds ?? 0;
      const d = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

/** Every top-level finance field that carries a Firestore timestamp. */
export const FINANCE_TIMESTAMP_FIELDS = [
  'createdAt',
  'updatedAt',
  'decidedAt',
  'approvedAt',
  'postedAt',
  'completedAt',
  'computedAt',
  'expiresAt',
  'slaDueAt',
  'deliveredToTreasurerAt',
  'deletedAt',
  'decidedAtSort',
  'decisionDate',
] as const;

/**
 * Return a copy of a seam-read document with every known timestamp field
 * normalized to an ISO string (null stays null; unparseable values are
 * left untouched so no information is silently destroyed).
 */
export function normalizeFinanceTimes<T extends Record<string, unknown>>(doc: T): T {
  const out: Record<string, unknown> = { ...doc };
  for (const f of FINANCE_TIMESTAMP_FIELDS) {
    if (out[f] === undefined || out[f] === null) continue;
    const iso = financeSupaTimestamp(out[f]);
    if (iso !== null) out[f] = iso;
  }
  return out as T;
}

/* ------------------------------------------- mirror-write serialization */

/**
 * Deep-convert a document being mirrored into its jsonb form:
 * Date / Timestamp-like / dump-shape values -> ISO strings;
 * serverTimestamp() sentinels ({ _methodName: 'serverTimestamp' } or the
 * fake-firestore { __serverTimestamp: true }) -> the current instant as
 * ISO (Firestore resolves its own sentinel on the primary write; the
 * mirror stamps approximately the same instant — Firestore stays
 * authoritative); other FieldValue sentinels -> null (no jsonb form);
 * arrays/plain objects recurse; everything else passes through.
 * Never throws.
 */
export function serializeForSupaMirror(value: unknown): unknown {
  try {
    return serializeValue(value);
  } catch {
    return value;
  }
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return financeSupaTimestamp(value);
  const v = value as Record<string, unknown> & {
    toDate?: () => Date;
    _methodName?: string;
    __serverTimestamp?: boolean;
    __arrayUnion?: unknown;
  };
  if (v.__serverTimestamp === true) return new Date().toISOString();
  if (typeof v._methodName === 'string') {
    return v._methodName === 'serverTimestamp' ? new Date().toISOString() : null;
  }
  if (v.__arrayUnion !== undefined) return serializeValue(v.__arrayUnion);
  if (typeof v.toDate === 'function') return financeSupaTimestamp(value);
  const seconds = (v._seconds as number) ?? (v.seconds as number);
  if (typeof seconds === 'number' && Object.keys(v).length <= 3) {
    return financeSupaTimestamp(value);
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
  return out;
}

/**
 * Mirror one committed Firestore write into its fs_* row. Best-effort by
 * contract: gated by the surface flag, never throws, never audited.
 * MANUAL_LIST writes must NOT be mirrored through here in this phase —
 * their seam modules simply never call this (see money-approvals /
 * reconciliations seams).
 */
export async function mirrorFinanceWrite(
  surface: string,
  op: 'set' | 'update' | 'delete',
  collectionPath: string,
  id: string,
  data?: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<void> {
  const port = financeSupaPort(surface);
  if (!port) return;
  try {
    if (op === 'delete') {
      await port.deleteDoc(collectionPath, id);
    } else if (op === 'update') {
      await port.updateDoc(collectionPath, id, (serializeForSupaMirror(data ?? {}) as Record<string, unknown>));
    } else {
      await port.setDoc(
        collectionPath,
        id,
        (serializeForSupaMirror(data ?? {}) as Record<string, unknown>),
        options,
      );
    }
  } catch (err) {
    console.error(`[finance-supa] mirror ${op} ${collectionPath}/${id} failed (Firestore is authoritative)`, err);
  }
}

/* --------------------------------------- Firestore-shaped result adapters */

/** One adapter doc ({ id, ...data }, times normalized) as a fake doc snap. */
export function supaDocToFakeDoc(doc: SupaDoc | null): {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
} {
  if (!doc) return { id: '', exists: false, data: () => undefined };
  const { id, ...rest } = normalizeFinanceTimes(doc as Record<string, unknown>);
  const data = rest as Record<string, unknown>;
  return { id: String(id), exists: true, data: () => data };
}

/** Adapter docs as a fake query snapshot ({ empty, docs: [{id, data()}] }). */
export function supaDocsToFakeSnap(docs: SupaDoc[]): {
  empty: boolean;
  size: number;
  docs: Array<{ id: string; data: () => Record<string, unknown> }>;
} {
  const fakeDocs = docs.map((d) => {
    const f = supaDocToFakeDoc(d);
    return { id: f.id, data: f.data as () => Record<string, unknown> };
  });
  return { empty: fakeDocs.length === 0, size: fakeDocs.length, docs: fakeDocs };
}
