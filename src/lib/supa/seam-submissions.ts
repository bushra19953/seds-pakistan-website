/**
 * Supabase seam for the TASKS cluster, group 5: the submissions route
 * (src/app/api/submissions/route.ts) where it joins the tasks world.
 *
 * INVENTORY FACT (see supa-rebase-notes/tasks-5.md for the full audit):
 * that route touches ZERO `tasks` docs. Its only join with the
 * tasks/gamification world is the PATCH review decision, which awards
 * points into the same users/points_audit economy the tasks cluster
 * runs on (direct batch increment, NOT via the canonical
 * gamification-transaction — known defect TS-P16, preserved faithfully).
 * This seam therefore provides:
 *   1. the task-join read primitive (`supaGetTaskDoc`) that any genuine
 *      task-joining read in this file-group must use, and
 *   2. the best-effort mirror for the review decision
 *      (`mirrorSubmissionReview`): Firestore stays primary; the mirror
 *      copies the decision's own write set (submission doc update,
 *      optional linked competition doc, optional points_audit doc)
 *      through the adapter. The users.points INCREMENT is deliberately
 *      NOT mirrored: a FieldValue.increment has no absolute-value
 *      equivalent without a read-modify-write, and guessing the new
 *      total would corrupt the mirror. Recorded in the rebase notes.
 *
 * This is the ONLY module in this file-group that knows Supabase
 * exists. It reaches the adapter (src/lib/supa/, built on a sibling
 * branch, ABSENT from this tree) via a lazy dynamic import through a
 * variable specifier typed to the local interfaces below, so tsc is
 * clean while the adapter is missing. It tolerates: module absent,
 * factory missing, methods missing, flag off, any call throwing. In
 * every such case it reports "unavailable" (null / false) and callers
 * keep EXACTLY today's Firestore behaviour. Flag OFF is never even a
 * data call.
 *
 * Surface string: exactly 'tasks' (the submissions-join surface rides
 * the tasks flag; the case for a future 'submissions' surface is
 * argued in supa-rebase-notes/tasks-5.md).
 *
 * No @supabase/supabase-js import; no new dependencies.
 */

/* ------------------------------------------------------------ interfaces */

export type SupaDocData = Record<string, unknown>;
export type SupaDoc = { id: string } & SupaDocData;

export interface SupaAdapterLike {
  getDoc?: (collection: string, id: string) => Promise<SupaDoc | null | undefined>;
  listDocs?: (collection: string, opts?: Record<string, unknown>) => Promise<SupaDoc[]>;
  countDocs?: (collection: string, where?: unknown) => Promise<number>;
  setDoc?: (
    collection: string,
    id: string,
    data: SupaDocData,
    opts?: { merge?: boolean },
  ) => Promise<unknown>;
  updateDoc?: (collection: string, id: string, data: SupaDocData) => Promise<unknown>;
  deleteDoc?: (collection: string, id: string) => Promise<unknown>;
}

interface SupaModuleLike {
  useSupa?: (surface: string) => boolean;
  getSupaAdapter?: () => SupaAdapterLike | null | undefined;
  getDoc?: SupaAdapterLike['getDoc'];
  listDocs?: SupaAdapterLike['listDocs'];
  countDocs?: SupaAdapterLike['countDocs'];
  setDoc?: SupaAdapterLike['setDoc'];
  updateDoc?: SupaAdapterLike['updateDoc'];
  deleteDoc?: SupaAdapterLike['deleteDoc'];
}

/** The one surface string for this file-group. */
export const SUBMISSIONS_JOIN_SURFACE = 'tasks';

/* ------------------------------------------------------- adapter loading */

let injectedAdapter: SupaAdapterLike | null | undefined;
let injectedUseSupa: ((surface: string) => boolean) | undefined;

/** Test injection point (mock only; no live client is ever built in
 * tests). Pass undefined to restore the real dynamic lookup. */
export function __setSubmissionsAdapterForTests(
  adapter: SupaAdapterLike | null | undefined,
  useSupa?: (surface: string) => boolean,
): void {
  injectedAdapter = adapter;
  injectedUseSupa = useSupa;
  cachedAdapter = undefined;
  cachedUseSupa = undefined;
}

let cachedAdapter: SupaAdapterLike | null | undefined;
let cachedUseSupa: ((surface: string) => boolean) | undefined;

async function loadAdapter(): Promise<SupaAdapterLike | null> {
  if (injectedAdapter !== undefined) return injectedAdapter;
  if (cachedAdapter !== undefined) return cachedAdapter;
  try {
    // Variable specifier on purpose: src/lib/supa/ is built on a
    // sibling branch and may not exist in this tree yet. A static
    // specifier would break tsc/build until merge; at merge time the
    // coordinator re-points this at the real adapter exports.
    const specifier = '@/lib/supa';
    const mod = (await import(/* webpackIgnore: true */ specifier)) as SupaModuleLike;
    cachedUseSupa = typeof mod.useSupa === 'function' ? mod.useSupa : undefined;
    let adapter: SupaAdapterLike | null = null;
    if (typeof mod.getSupaAdapter === 'function') {
      try {
        adapter = (await mod.getSupaAdapter()) ?? null;
      } catch {
        adapter = null;
      }
    }
    if (!adapter && (mod.getDoc || mod.listDocs || mod.setDoc)) {
      adapter = {
        getDoc: mod.getDoc,
        listDocs: mod.listDocs,
        countDocs: mod.countDocs,
        setDoc: mod.setDoc,
        updateDoc: mod.updateDoc,
        deleteDoc: mod.deleteDoc,
      };
    }
    cachedAdapter =
      adapter && (adapter.getDoc || adapter.listDocs || adapter.setDoc || adapter.updateDoc)
        ? adapter
        : null;
  } catch {
    cachedAdapter = null;
    cachedUseSupa = undefined;
  }
  return cachedAdapter;
}

/* ------------------------------------------------------------- flag gate */

/** Parse a SUPA_SURFACES value exactly like the real adapter's
 * flags.ts: comma list, case-insensitive, '*' means every surface. */
export function supaSurfacesInclude(raw: string | undefined, surface: string): boolean {
  if (!raw) return false;
  const surfaces = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(surface.trim().toLowerCase());
}

function localEnvFlag(surface: string): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return supaSurfacesInclude(process.env.SUPA_SURFACES, surface);
}

/**
 * Is the 'tasks' surface switched to Supabase right now? True only
 * when an adapter exists AND its useSupa (or, for injected adapters
 * without one, the SUPA_SURFACES env parse) says so. Never throws.
 * Default OFF in every failure mode.
 */
export async function supaTasksSurfaceEnabled(): Promise<boolean> {
  try {
    if (injectedAdapter !== undefined) {
      if (!injectedAdapter) return false;
      if (injectedUseSupa) return injectedUseSupa(SUBMISSIONS_JOIN_SURFACE) === true;
      if (typeof (injectedAdapter as SupaModuleLike).useSupa === 'function') {
        return (
          (injectedAdapter as SupaModuleLike).useSupa!(SUBMISSIONS_JOIN_SURFACE) === true
        );
      }
      return localEnvFlag(SUBMISSIONS_JOIN_SURFACE);
    }
    const adapter = await loadAdapter();
    if (!adapter) return false;
    if (cachedUseSupa) return cachedUseSupa(SUBMISSIONS_JOIN_SURFACE) === true;
    return localEnvFlag(SUBMISSIONS_JOIN_SURFACE);
  } catch {
    return false;
  }
}

/* ------------------------------------------- timestamp normalization */
/*
 * Firestore docs read through this route pass timestamps as Timestamp
 * objects and the route renders them with
 * `value?.toDate?.()?.toISOString() || null`. jsonb returns ISO
 * strings instead, on which `.toDate` does not exist — a naive swap
 * would null out real timestamps. These helpers reproduce the
 * Firestore-path output for every shape: ISO string passes through,
 * Date / Timestamp-like / {seconds,nanoseconds} become ISO strings,
 * anything else becomes null.
 */
export function normalizeTimestampValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'object') {
    const v = value as {
      toDate?: () => Date;
      seconds?: number;
      _seconds?: number;
      nanoseconds?: number;
      _nanoseconds?: number;
    };
    if (typeof v.toDate === 'function') {
      try {
        const d = v.toDate();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
      } catch {
        return null;
      }
    }
    const seconds = typeof v.seconds === 'number' ? v.seconds : v._seconds;
    if (typeof seconds === 'number') {
      const nanos =
        typeof v.nanoseconds === 'number'
          ? v.nanoseconds
          : typeof v._nanoseconds === 'number'
            ? v._nanoseconds
            : 0;
      const d = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  }
  return null;
}

/** Return a copy of `doc` with the named fields run through
 * normalizeTimestampValue. Fields absent from the doc stay absent. */
export function normalizeTimestampFields<T extends Record<string, unknown>>(
  doc: T,
  fields: readonly string[],
): T {
  const out: Record<string, unknown> = { ...doc };
  for (const field of fields) {
    if (field in out) out[field] = normalizeTimestampValue(out[field]);
  }
  return out as T;
}

/** Make a Firestore-bound payload safe to mirror into jsonb: Date and
 * Timestamp-like values become ISO strings, recursively for plain
 * objects/arrays; everything else passes through untouched. */
export function sanitizeForMirror(value: unknown): unknown {
  if (value instanceof Date) return normalizeTimestampValue(value);
  if (value !== null && typeof value === 'object') {
    const v = value as { toDate?: unknown };
    if (typeof v.toDate === 'function') return normalizeTimestampValue(value);
    if (Array.isArray(value)) return value.map(sanitizeForMirror);
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
        out[k] = sanitizeForMirror(val);
      }
      return out;
    }
    // Class instances (FieldValue sentinels etc.) are not jsonb data;
    // the route builds mirror payloads from plain fields, so anything
    // reaching here is dropped to null rather than serialized wrongly.
    return null;
  }
  return value;
}

/* ------------------------------------------------------- task-join read */

/** Timestamp fields a task doc carries that this route family renders. */
export const TASK_DOC_TIMESTAMP_FIELDS = [
  'submittedAt',
  'createdAt',
  'updatedAt',
  'deadline',
  'completedAt',
  'reviewedAt',
] as const;

/**
 * THE task-joining read primitive for this file-group: fetch one task
 * doc through the adapter, timestamps normalized to the Firestore
 * path's ISO-string shape. Returns null when the surface is off, the
 * adapter is unavailable, the doc does not exist, or the call throws —
 * every null means "use Firestore exactly as today". (The current
 * route performs no task read; this primitive exists so the first
 * genuine join lands here instead of growing a second seam. Its
 * behaviour is pinned by unit tests with a mocked adapter.)
 */
export async function supaGetTaskDoc(taskId: string): Promise<SupaDoc | null> {
  try {
    if (!(await supaTasksSurfaceEnabled())) return null;
    const adapter = injectedAdapter !== undefined ? injectedAdapter : await loadAdapter();
    if (!adapter || typeof adapter.getDoc !== 'function') return null;
    const doc = await adapter.getDoc('tasks', taskId);
    if (!doc) return null;
    return normalizeTimestampFields(doc as SupaDoc, TASK_DOC_TIMESTAMP_FIELDS);
  } catch {
    return null;
  }
}

/* ------------------------------------------------- review-decision mirror */

export interface SubmissionReviewMirror {
  submissionId: string;
  /** Submission-doc status literal, submission vocabulary ('approved' | 'rejected'). */
  status: string;
  reviewedBy: string;
  reviewerDisplayName: string;
  reviewNotes: string | null;
  pointsAwarded: number;
  /** ISO string standing in for the Firestore serverTimestamp. */
  reviewedAtIso: string;
  linkedCompetitionId?: string | null;
  /** Plain competition payload (already built for the Firestore batch). */
  competition?: Record<string, unknown> | null;
  competitionCreatedAtIso?: string;
  auditId?: string | null;
  /** Plain points_audit payload (already built for the Firestore batch). */
  audit?: Record<string, unknown> | null;
  auditTimestampIso?: string;
}

/**
 * Best-effort mirror of a PATCH review decision AFTER the Firestore
 * batch has committed. Returns true only when the surface is on, an
 * adapter exists, and every mirror write succeeded. NEVER throws:
 * a false return leaves the request exactly as successful as the
 * Firestore commit made it. The users.points increment and the
 * submitter notification are NOT mirrored (see header).
 */
export async function mirrorSubmissionReview(mirror: SubmissionReviewMirror): Promise<boolean> {
  try {
    if (!(await supaTasksSurfaceEnabled())) return false;
    const adapter = injectedAdapter !== undefined ? injectedAdapter : await loadAdapter();
    if (!adapter) return false;

    if (typeof adapter.updateDoc === 'function') {
      await adapter.updateDoc('submissions', mirror.submissionId, {
        status: mirror.status,
        reviewedAt: mirror.reviewedAtIso,
        reviewedBy: mirror.reviewedBy,
        reviewerDisplayName: mirror.reviewerDisplayName,
        reviewNotes: mirror.reviewNotes,
        pointsAwarded: mirror.pointsAwarded,
        ...(mirror.linkedCompetitionId
          ? { linkedCompetitionId: mirror.linkedCompetitionId }
          : {}),
      });
    }
    if (mirror.linkedCompetitionId && mirror.competition && typeof adapter.setDoc === 'function') {
      await adapter.setDoc('competitions', mirror.linkedCompetitionId, {
        ...(sanitizeForMirror(mirror.competition) as Record<string, unknown>),
        createdAt: mirror.competitionCreatedAtIso ?? mirror.reviewedAtIso,
      });
    }
    if (mirror.auditId && mirror.audit && typeof adapter.setDoc === 'function') {
      await adapter.setDoc('points_audit', mirror.auditId, {
        ...(sanitizeForMirror(mirror.audit) as Record<string, unknown>),
        timestamp: mirror.auditTimestampIso ?? mirror.reviewedAtIso,
      });
    }
    return true;
  } catch (err) {
    console.error('[submissions][supa-mirror] mirror failed (Firestore remains primary):', err);
    return false;
  }
}
