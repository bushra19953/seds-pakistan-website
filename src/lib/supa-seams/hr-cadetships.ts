/**
 * Supabase seam for the HR cadetships surface (cadetships + its
 * evaluations subcollection).
 *
 * This module is the ONLY place in the cadetships cluster that knows
 * about the Supabase adapter. It deliberately does NOT import
 * `src/lib/supa/`: that package is not in the base branch this work
 * forks from. The adapter interface below is declared locally,
 * identical in shape to the real one on branch feat/supa-adapter
 * (src/lib/supa/adapter.ts: SupaAdapter, SupaDoc, DocData, WhereClause,
 * WhereOp, OrderSpec, ListOptions) and to the sibling hr-leave seam.
 * At merge time the local declarations are deleted and `getAdapter()`
 * is re-pointed at `getSupaAdapter()` from `@/lib/supa` -- a pure
 * import swap, no call-site changes.
 *
 * Landing tables (written by the real adapter):
 *   cadetships                       -> fs_cadetships
 *   cadetships/{id}/evaluations      -> fs_group_evaluations
 *     (subcollection family table, discriminated by parent_path =
 *      'cadetships/{id}'; the adapter derives this from the full
 *      collection path, so evaluations are ALWAYS addressed through
 *      `cadetships/{id}/evaluations`, never as a bare 'evaluations'
 *      collection -- evaluation doc ids are role names
 *      ('chapter_president' / 'team_lead') that collide across
 *      cadetships, and only (parent_path, id) discriminates them.)
 * All filtering in this seam is on `data` jsonb fields (personUid,
 * status, ...) via the adapter's WhereClause tuples -- never on the
 * firebase_uid column, which the migration kit leaves unpopulated
 * for the HR tables.
 *
 * Behaviour contract:
 * - Flag OFF (SUPA_SURFACES does not contain 'cadetships' or '*'), no
 *   adapter (getAdapter() returns null until the merge), or any
 *   adapter error: callers fall back to the exact current Firestore
 *   behaviour.
 * - Flag ON: reads go through the adapter; writes are dual --
 *   Firestore stays primary and the seam mirrors to Supabase so the
 *   mirror never goes stale. Mirror failures are swallowed (logged)
 *   and never change the Firestore result or the response shape.
 *
 * Timestamp conversions (the cadetship bug class, design-verdict pin
 * (a)): Firestore Timestamps come back from jsonb as ISO strings, and
 * `cadetshipFromFirestore`'s asDate() returns null for ISO strings,
 * silently substituting new Date(0) for startedAt / probationEnd /
 * createdAt / updatedAt. This seam converts ISO strings to real Date
 * objects BEFORE any serialize.ts consumer sees the data:
 * - Cadetship fields: startedAt, probationEnd, extendedTo,
 *   evaluationReminderSentAt, createdAt, updatedAt, nested
 *   decision.decidedAt, duesGate.lastCheckedAt, and the item stamps
 *   items.orientation.attestedAt, items.workshops.attestations[].attestedAt,
 *   items.sprintTask.completedAt, conduct.acknowledgedAt.
 * - Evaluation fields: submittedAt, revisedAt.
 * - Outbound (Firestore -> Supa): Date / Timestamp-like /
 *   serverTimestamp sentinel values become ISO strings
 *   (serializeValueForSupa / serializeDataForSupa).
 *
 * NOT migrated by this seam (cross-collection, stay on Firestore,
 * design verdict section 1.7): users (display-name lookups), roles
 * (caller role + team-lead resolution), tasks (team-lead + cron
 * sprint sweep), applications (decision write-back in the decision
 * route), audit_logs / writeGovernanceAuditOrThrow.
 * NOT edited by this branch (governance lifecycle sub-cluster):
 * src/lib/server/cadetship/** -- including create.ts (the CREATE
 * transaction, allocation A22), access.ts, serialize.ts and
 * cron-stanza.ts. The seam supplies the readers cron-stanza will
 * consume at the integration step (tryListCadetships /
 * tryListEvaluations); see the wiring spec in the cluster report.
 */

export type DocData = Record<string, unknown>;
export type SupaDoc = { id: string } & DocData;

export type WhereOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'array-contains';
export type WhereClause = [field: string, op: WhereOp, value: unknown];

export interface OrderSpec {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface ListOptions {
  where?: WhereClause[];
  orderBy?: string | OrderSpec | OrderSpec[];
  limit?: number;
  startAfter?: string | number;
}

/** Identical to SupaAdapter in src/lib/supa/adapter.ts (feat/supa-adapter). */
export interface SupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(collectionPath: string, options?: ListOptions): Promise<SupaDoc[]>;
  countDocs(collectionPath: string, where?: WhereClause[]): Promise<number>;
  setDoc(
    collectionPath: string,
    id: string,
    data: DocData,
    options?: { merge?: boolean },
  ): Promise<SupaDoc>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: DocData,
  ): Promise<SupaDoc>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

export const CADETSHIPS_COLLECTION = 'cadetships';
export const CADETSHIPS_SURFACE = 'cadetships';

/** Full subcollection path for one cadetship's evaluations. */
export function evaluationsPath(cadetshipId: string): string {
  return `cadetships/${cadetshipId}/evaluations`;
}

/* ------------------------------------------------------------ flag gate */
/* Mirrors src/lib/supa/flags.ts (feat/supa-adapter) exactly. */

export function parseSupaSurfaces(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function useSupa(surface: string): boolean {
  const surfaces = parseSupaSurfaces(process.env.SUPA_SURFACES);
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(surface.trim().toLowerCase());
}

/**
 * Mirrors src/lib/supa/client.ts: returns null when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are unset. Until the merge lands the real
 * client factory, this seam has no client to build, so it always
 * returns null in this branch.
 */
export function getSupaClient(): null {
  return null;
}

/* -------------------------------------------------------- adapter access */

let adapterOverride: SupaAdapter | null | undefined;

/**
 * The adapter for this surface, or null when Supabase is not wired yet.
 * Until the merge re-points this at getSupaAdapter() from '@/lib/supa',
 * it returns null (tests inject a fake via setAdapterForTests).
 */
export function getAdapter(): SupaAdapter | null {
  if (adapterOverride !== undefined) return adapterOverride;
  return null;
}

/** Test-only injection point for a mocked adapter. */
export function setAdapterForTests(adapter: SupaAdapter | null): void {
  adapterOverride = adapter;
}

export function resetAdapterForTests(): void {
  adapterOverride = undefined;
}

/** True only when the flag is ON for 'cadetships' AND an adapter exists. */
export function isCadetshipsSupaEnabled(): boolean {
  return useSupa(CADETSHIPS_SURFACE) && getAdapter() !== null;
}

/* ------------------------------------------------- timestamp conversions */

function isTimestampLike(value: unknown): value is { toDate: () => Date } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  );
}

function isServerTimestampSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.__sentinel === 'serverTimestamp') return true;
  if (typeof record._methodName === 'string' && record._methodName.includes('serverTimestamp')) {
    return true;
  }
  return false;
}

export function isDeleteSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.__sentinel === 'delete') return true;
  if (typeof record._methodName === 'string' && record._methodName.includes('deleteField')) {
    return true;
  }
  return false;
}

/** One Firestore-side value -> its jsonb representation. */
export function serializeValueForSupa(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (isServerTimestampSentinel(value)) return new Date().toISOString();
  if (isTimestampLike(value)) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValueForSupa);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isDeleteSentinel(inner)) continue;
      out[key] = serializeValueForSupa(inner);
    }
    return out;
  }
  return value;
}

/** A whole document body -> jsonb-ready data (delete sentinels dropped). */
export function serializeDataForSupa(data: DocData): DocData {
  const out: DocData = {};
  for (const [key, value] of Object.entries(data)) {
    if (isDeleteSentinel(value)) continue;
    out[key] = serializeValueForSupa(value);
  }
  return out;
}

/** ISO string / Date / Timestamp-like -> a real Date, else unchanged. */
export function toDateValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms);
  }
  if (isTimestampLike(value)) return value.toDate();
  return value;
}

export const CADETSHIP_DATE_FIELDS = [
  'startedAt',
  'probationEnd',
  'extendedTo',
  'evaluationReminderSentAt',
  'createdAt',
  'updatedAt',
] as const;

export const EVALUATION_DATE_FIELDS = ['submittedAt', 'revisedAt'] as const;

function convertNestedDates(doc: DocData): DocData {
  const out: DocData = { ...doc };
  const decision = out.decision as DocData | null | undefined;
  if (decision && typeof decision === 'object') {
    out.decision = { ...decision, decidedAt: toDateValue(decision.decidedAt) ?? null };
    if (decision.decidedAt === undefined || decision.decidedAt === null) {
      (out.decision as DocData).decidedAt = null;
    }
  }
  const duesGate = out.duesGate as DocData | null | undefined;
  if (duesGate && typeof duesGate === 'object') {
    out.duesGate = {
      ...duesGate,
      lastCheckedAt:
        duesGate.lastCheckedAt == null ? null : toDateValue(duesGate.lastCheckedAt),
    };
  }
  const items = out.items as DocData | null | undefined;
  if (items && typeof items === 'object') {
    const nextItems: DocData = { ...items };
    const orientation = items.orientation as DocData | null | undefined;
    if (orientation && typeof orientation === 'object') {
      nextItems.orientation = {
        ...orientation,
        attestedAt: orientation.attestedAt == null ? null : toDateValue(orientation.attestedAt),
      };
    }
    const workshops = items.workshops as DocData | null | undefined;
    if (workshops && typeof workshops === 'object' && Array.isArray(workshops.attestations)) {
      nextItems.workshops = {
        ...workshops,
        attestations: workshops.attestations.map((a) => {
          const att = a as DocData;
          return { ...att, attestedAt: toDateValue(att.attestedAt) };
        }),
      };
    }
    const sprintTask = items.sprintTask as DocData | null | undefined;
    if (sprintTask && typeof sprintTask === 'object') {
      nextItems.sprintTask = {
        ...sprintTask,
        completedAt: sprintTask.completedAt == null ? null : toDateValue(sprintTask.completedAt),
      };
    }
    out.items = nextItems;
  }
  const conduct = out.conduct as DocData | null | undefined;
  if (conduct && typeof conduct === 'object') {
    out.conduct = {
      ...conduct,
      acknowledgedAt: conduct.acknowledgedAt == null ? null : toDateValue(conduct.acknowledgedAt),
    };
  }
  return out;
}

/**
 * A raw Supa cadetship body -> the shape cadetshipFromFirestore expects:
 * every date field a real Date (never an ISO string, never epoch-by-null).
 */
export function convertCadetshipDates<T extends DocData>(doc: T): T {
  const out = convertNestedDates(doc);
  for (const field of CADETSHIP_DATE_FIELDS) {
    if (out[field] !== undefined && out[field] !== null) {
      out[field] = toDateValue(out[field]);
    }
  }
  return out as T;
}

/** A raw Supa evaluation body -> evaluationFromFirestore-ready shape. */
export function convertEvaluationDates<T extends DocData>(doc: T): T {
  const out: DocData = { ...doc };
  for (const field of EVALUATION_DATE_FIELDS) {
    if (out[field] !== undefined && out[field] !== null) {
      out[field] = toDateValue(out[field]);
    }
  }
  return out as T;
}

/* -------------------------------------------------------------- reading */

export type SupaReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'disabled' }
  | { status: 'error'; error: unknown };

async function readResult<T>(run: (adapter: SupaAdapter) => Promise<T>): Promise<SupaReadResult<T>> {
  const adapter = getAdapter();
  if (!useSupa(CADETSHIPS_SURFACE) || !adapter) return { status: 'disabled' };
  try {
    return { status: 'ok', value: await run(adapter) };
  } catch (error) {
    return { status: 'error', error };
  }
}

/** Raw Supa cadetship (dates still ISO strings), or a status. */
export function tryGetCadetshipRaw(id: string): Promise<SupaReadResult<SupaDoc | null>> {
  return readResult((adapter) => adapter.getDoc(CADETSHIPS_COLLECTION, id));
}

/** Supa cadetship with real Date date-fields. */
export async function tryGetCadetship(id: string): Promise<SupaReadResult<SupaDoc | null>> {
  const result = await tryGetCadetshipRaw(id);
  if (result.status !== 'ok' || result.value === null) return result;
  return { status: 'ok', value: convertCadetshipDates(result.value) };
}

export function tryListCadetships(
  options?: ListOptions,
): Promise<SupaReadResult<SupaDoc[]>> {
  return readResult(async (adapter) => {
    const docs = await adapter.listDocs(CADETSHIPS_COLLECTION, options);
    return docs.map((doc) => convertCadetshipDates(doc));
  });
}

/**
 * The caller's own live cadetship (acknowledge-conduct surface):
 * personUid == uid AND status in the supplied live-status list.
 */
export function tryFindLiveCadetshipForPerson(
  personUid: string,
  liveStatuses: readonly string[],
): Promise<SupaReadResult<SupaDoc | null>> {
  return readResult(async (adapter) => {
    const docs = await adapter.listDocs(CADETSHIPS_COLLECTION, {
      where: [
        ['personUid', '==', personUid],
        ['status', 'in', [...liveStatuses]],
      ],
      limit: 1,
    });
    return docs.length > 0 ? convertCadetshipDates(docs[0]) : null;
  });
}

/**
 * All evaluations of ONE cadetship, addressed by the full subcollection
 * path so role-name doc ids can never cross-contaminate cadetships.
 */
export function tryListEvaluations(
  cadetshipId: string,
): Promise<SupaReadResult<SupaDoc[]>> {
  return readResult(async (adapter) => {
    const docs = await adapter.listDocs(evaluationsPath(cadetshipId));
    return docs.map((doc) => convertEvaluationDates(doc));
  });
}

export function tryGetEvaluation(
  cadetshipId: string,
  evaluatorRole: string,
): Promise<SupaReadResult<SupaDoc | null>> {
  return readResult(async (adapter) => {
    const doc = await adapter.getDoc(evaluationsPath(cadetshipId), evaluatorRole);
    return doc ? convertEvaluationDates(doc) : null;
  });
}

/* -------------------------------------------------------------- writing */
/* Dual-write mirrors: Firestore is written first by the caller; these
 * mirror the same change to Supabase. They never throw. */

async function mirror(run: (adapter: SupaAdapter) => Promise<unknown>): Promise<boolean> {
  const adapter = getAdapter();
  if (!useSupa(CADETSHIPS_SURFACE) || !adapter) return false;
  try {
    await run(adapter);
    return true;
  } catch (error) {
    console.error('[hr-cadetships seam] Supabase mirror failed; Firestore remains primary:', error);
    return false;
  }
}

export function mirrorCadetshipSet(id: string, data: DocData): Promise<boolean> {
  const serialized = serializeDataForSupa(data);
  return mirror((adapter) => adapter.setDoc(CADETSHIPS_COLLECTION, id, serialized));
}

export function mirrorCadetshipUpdate(id: string, updates: DocData): Promise<boolean> {
  const serialized = serializeDataForSupa(updates);
  return mirror((adapter) => adapter.updateDoc(CADETSHIPS_COLLECTION, id, serialized));
}

export function mirrorCadetshipDelete(id: string): Promise<boolean> {
  return mirror((adapter) => adapter.deleteDoc(CADETSHIPS_COLLECTION, id));
}

export function mirrorEvaluationSet(
  cadetshipId: string,
  evaluatorRole: string,
  data: DocData,
): Promise<boolean> {
  const serialized = serializeDataForSupa(data);
  return mirror((adapter) =>
    adapter.setDoc(evaluationsPath(cadetshipId), evaluatorRole, serialized),
  );
}
