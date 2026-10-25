/**
 * Universal Inbox -> Supabase seam (Firestore -> Supabase migration,
 * notifications cluster G3: Universal Inbox).
 *
 * EVERY Supabase touch for the Universal Inbox surface lives in this one
 * module, so the merge step can re-point the seam at the real adapter
 * (src/lib/supa/, branch feat/supa-adapter) with edits confined to the
 * "ADAPTER BRIDGE" section below plus the two flag helpers:
 *
 *   supaFetchInboxFeeds        <->  adapter listDocs per feed collection
 *   supaUpdateInboxDoc         <->  adapter updateDoc(collection, id, partial)
 *   inboxSupaServerEnabled()   <->  adapter useSupa('inbox')
 *   inboxSupaClientEnabled()   <->  adapter useSupa('inbox') (public twin)
 *
 * Until the adapter lands, the bridge speaks PostgREST directly with
 * fetch (the adapter branch owns the @supabase/supabase-js dependency).
 *
 * Flag names are frozen by the adapter: the surface list env is
 * SUPA_SURFACES (comma-separated surface names, '*' = all). Server code
 * reads SUPA_SURFACES; browser code can only see the NEXT_PUBLIC_ twin,
 * NEXT_PUBLIC_SUPA_SURFACES, which rollout sets to the same value. The
 * client uses its flag as a hint to try the API route, and the route
 * re-checks the server flag (and the server config) before serving
 * anything, so a stale or forged client hint can never widen access.
 *
 * Fallback contract (identical for every consumer): flag OFF, Supabase
 * unconfigured, route missing, or ANY error -> the caller behaves
 * exactly as it does on Firestore today. Read helpers throw only so the
 * caller can fall back to its Firestore code path; mirror helpers never
 * throw.
 *
 * =====================================================================
 * KNOWN DEFECTS reproduced EXACTLY (flagged, NEVER fixed here)
 * =====================================================================
 * (a) SUBMISSION tab vocabulary mismatch: writers store lowercase `type`
 *     values (e.g. 'competition') on submissions docs, while the tab
 *     filter in page.tsx compares s.type === activeTab with tab id
 *     'SUBMISSION'. Only docs whose type literally equals 'SUBMISSION'
 *     ever show on that tab. matchesInboxTab() below is that identical
 *     comparison, and the seam applies no case-folding or mapping.
 * (b) The submissions Firestore listener orders by `created_at`
 *     (page.tsx, submissions listener), a field writers never set. In
 *     Firestore, orderBy EXCLUDES documents missing the ordered field.
 *     selectSubmissionsFeed() reproduces the exclusion: rows whose data
 *     lacks created_at are dropped, never silently included.
 * (c) The FORM_RESPONSE tab has NO data feed at all today: no listener
 *     or query populates rows with type 'FORM_RESPONSE'. INBOX_FEEDS
 *     below therefore has exactly five feeds and NO form_responses feed;
 *     the tab stays feedless in Supabase mode too.
 * =====================================================================
 *
 * Timestamp reality of the fs_* jsonb columns: Firestore Timestamp
 * objects do not survive JSON. Depending on the producer a stored
 * timestamp is an ISO string (this module's mirror writes), an Admin-SDK
 * dump object ({ _seconds, _nanoseconds } or { seconds, nanoseconds },
 * from migrate_db.js JSON.stringify of doc.data()), or an epoch number.
 * supaTimestampToIso / supaTimestampToMillis normalize every one of
 * those. restoreInboxTimestamps() converts the known timestamp fields
 * of a raw jsonb row back into Firestore Timestamp instances (factory
 * injected by the page) so the page's existing rendering (.toDate()),
 * fallback synthesis, and client-side sorts (.toMillis()) run
 * unchanged.
 */

// ---------------------------------------------------------------------------
// Flags (re-point at adapter useSupa('inbox') at merge time)
// ---------------------------------------------------------------------------

const SURFACE = 'inbox';

function surfaceListHas(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((s) => s === SURFACE || s === '*');
}

/** Server-side flag: the SUPA_SURFACES env frozen by the adapter. */
export function inboxSupaServerEnabled(): boolean {
  return surfaceListHas(process.env.SUPA_SURFACES);
}

/**
 * Client-side hint: the NEXT_PUBLIC_ twin of SUPA_SURFACES. Only a hint
 * to attempt the API route; the route re-checks the server flag.
 */
export function inboxSupaClientEnabled(): boolean {
  return surfaceListHas(process.env.NEXT_PUBLIC_SUPA_SURFACES);
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface SupaServerConfig {
  url: string;
  serviceRoleKey: string;
}

/**
 * The Supabase server config, or null when unconfigured. Server-only:
 * the service role key must never reach a browser bundle, so this reads
 * non-public env vars (undefined in client bundles) and its callers are
 * route handlers.
 */
export function getInboxSupaServerConfig(): SupaServerConfig | null {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

// ---------------------------------------------------------------------------
// Feed inventory (source collection per feed; fs_* table per migrate_db.js:
// table = `fs_${collection.replace(/[^a-zA-Z0-9_]/g, '_')}`)
// ---------------------------------------------------------------------------

export interface InboxFeedSpec {
  feed: string;
  collection: string;
  table: string;
}

export const INBOX_FEEDS: readonly InboxFeedSpec[] = [
  // orderBy('created_at','desc') + limit(100); orderBy EXCLUDES docs
  // missing created_at (defect (b) above).
  { feed: 'submissions', collection: 'submissions', table: 'fs_submissions' },
  // Two tasks queries (same collection, two status filters), each
  // where-only + limit(100); sorting is client-side in the page.
  { feed: 'tasksSubmitted', collection: 'tasks', table: 'fs_tasks' },
  { feed: 'tasksProof', collection: 'tasks', table: 'fs_tasks' },
  // where('status','==','pending') + limit(100); client-side sort.
  { feed: 'leaveRequests', collection: 'leave_requests', table: 'fs_leave_requests' },
  // where('status','in',[...]) + limit(100); client-side sort.
  { feed: 'applications', collection: 'applications', table: 'fs_applications' },
  // DEFECT (c): deliberately NO entry for form_responses / FORM_RESPONSE.
];

export type SupaRow = { id: string; data: any };

export interface InboxFeeds {
  submissions: SupaRow[];
  tasksSubmitted: SupaRow[];
  tasksProof: SupaRow[];
  leaveRequests: SupaRow[];
  applications: SupaRow[];
}

// ---------------------------------------------------------------------------
// Timestamp normalization (jsonb reality)
// ---------------------------------------------------------------------------

/**
 * Inbox fields that carry Firestore timestamps when stored. Only these
 * are restored to Timestamp instances for the page; plain date strings
 * such as leave startDate / endDate are NOT in this list because the
 * page's leave formatter treats them as opaque labels.
 */
export const INBOX_TIMESTAMP_FIELDS = [
  'created_at',
  'createdAt',
  'submittedAt',
  'updatedAt',
  'reviewedAt',
  'deadline',
  'timestamp',
] as const;

/** Normalize any stored timestamp representation to an ISO string, or null. */
export function supaTimestampToIso(value: any): string | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === 'string') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : value;
    }
    if (typeof value === 'number') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value?.toDate === 'function') {
      const d = value.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;
    }
    const seconds = value?._seconds ?? value?.seconds;
    if (typeof seconds === 'number') {
      const nanos = value?._nanoseconds ?? value?.nanoseconds ?? 0;
      const d = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

/** Milliseconds for any stored timestamp representation, or null. */
export function supaTimestampToMillis(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value?.toMillis === 'function') {
    const ms = value.toMillis();
    return typeof ms === 'number' && !isNaN(ms) ? ms : null;
  }
  const iso = supaTimestampToIso(value);
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

function isTimestampLikeValue(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return true;
  if (typeof value?.toDate === 'function') return true;
  // ISO datetime strings only (a bare date like '2026-10-20' is a label,
  // not a timestamp, and is left alone).
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(value);
  if (typeof value === 'object') {
    return typeof value._seconds === 'number' || typeof value.seconds === 'number';
  }
  return false;
}

/**
 * Convert the known timestamp fields of one raw jsonb row back into
 * Firestore Timestamp instances so the page's existing code (render
 * .toDate(), synthesized created_at fallbacks, .toMillis() sorts) runs
 * unchanged. The Timestamp factory is injected so this module stays
 * free of a firebase/firestore value import: the page passes
 * (d) => Timestamp.fromDate(d).
 */
export function restoreInboxTimestamps(
  data: Record<string, any>,
  makeTimestamp: (d: Date) => any,
): Record<string, any> {
  const out = { ...(data ?? {}) };
  for (const field of INBOX_TIMESTAMP_FIELDS) {
    if (!isTimestampLikeValue(out[field])) continue;
    const iso = supaTimestampToIso(out[field]);
    if (iso !== null) out[field] = makeTimestamp(new Date(iso));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tab filter (defect (a): the identical comparison, no vocabulary mapping)
// ---------------------------------------------------------------------------

/**
 * The page's tab comparison, verbatim: a row shows on a non-ALL tab only
 * when its type literally equals the tab id. DEFECT (a): submissions
 * writers store lowercase types, the tab id is 'SUBMISSION', so the
 * Competitions & Resources tab only ever shows docs whose type is
 * literally 'SUBMISSION'. Reproduced exactly; do not "fix" here.
 */
export function matchesInboxTab(rowType: string, activeTab: string): boolean {
  return rowType === activeTab;
}

// ---------------------------------------------------------------------------
// Feed selection (pure replication of each Firestore listener's semantics)
// ---------------------------------------------------------------------------

function hasStoredField(data: any, field: string): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    Object.prototype.hasOwnProperty.call(data, field) &&
    data[field] !== undefined
  );
}

function byIdAsc(a: SupaRow, b: SupaRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * submissions listener: query(collection 'submissions',
 * orderBy('created_at','desc'), limit(100)).
 *
 * DEFECT (b), reproduced loudly: Firestore orderBy EXCLUDES documents
 * missing the ordered field, and writers never set `created_at` on
 * submissions docs. Rows whose data lacks created_at are therefore
 * dropped here, exactly as the Firestore listener drops them. Sorting
 * is created_at descending; Firestore breaks orderBy ties by document
 * id in the query direction (descending here). A present-but-null
 * created_at is a stored value in Firestore and is kept, sorting last.
 */
export function selectSubmissionsFeed(rows: SupaRow[], limitCount = 100): SupaRow[] {
  const kept = rows.filter((r) => hasStoredField(r.data, 'created_at'));
  kept.sort((a, b) => {
    const am = supaTimestampToMillis(a.data?.created_at) ?? Number.NEGATIVE_INFINITY;
    const bm = supaTimestampToMillis(b.data?.created_at) ?? Number.NEGATIVE_INFINITY;
    if (bm !== am) return bm - am;
    return byIdAsc(b, a);
  });
  return kept.slice(0, limitCount);
}

/**
 * Tasks submitted-for-review listener: where('status','==',
 * 'submitted-for-review') + limit(100), no orderBy (Firestore returns
 * where-only queries in document-id order; sorting is client-side).
 */
export function selectTasksSubmittedFeed(rows: SupaRow[], limitCount = 100): SupaRow[] {
  return rows
    .filter((r) => r.data?.status === 'submitted-for-review')
    .sort(byIdAsc)
    .slice(0, limitCount);
}

/**
 * Tasks proof listener: where('status','in',['pending','in-progress'])
 * + limit(100), no orderBy. The page's deliverableFiles (hasProof)
 * filter stays client-side in the page, exactly as today.
 */
export function selectTasksProofFeed(rows: SupaRow[], limitCount = 100): SupaRow[] {
  return rows
    .filter((r) => r.data?.status === 'pending' || r.data?.status === 'in-progress')
    .sort(byIdAsc)
    .slice(0, limitCount);
}

/**
 * Leave listener: where('status','==','pending') + limit(100), no
 * orderBy; sorting is client-side in the page.
 */
export function selectLeaveFeed(rows: SupaRow[], limitCount = 100): SupaRow[] {
  return rows
    .filter((r) => r.data?.status === 'pending')
    .sort(byIdAsc)
    .slice(0, limitCount);
}

export const APPLICATION_INBOX_STATUSES = [
  'pending',
  'under_review',
  'shortlisted',
  'on_hold',
] as const;

/**
 * Applications listener: where('status','in', APPLICATION_INBOX_STATUSES)
 * + limit(100), no orderBy; sorting is client-side in the page.
 */
export function selectApplicationsFeed(rows: SupaRow[], limitCount = 100): SupaRow[] {
  return rows
    .filter((r) => (APPLICATION_INBOX_STATUSES as readonly string[]).includes(r.data?.status))
    .sort(byIdAsc)
    .slice(0, limitCount);
}

/** Apply every feed selector to raw rows grouped by collection. */
export function selectInboxFeeds(rowsByCollection: {
  submissions?: SupaRow[];
  tasks?: SupaRow[];
  leave_requests?: SupaRow[];
  applications?: SupaRow[];
}): InboxFeeds {
  const tasks = rowsByCollection.tasks ?? [];
  return {
    submissions: selectSubmissionsFeed(rowsByCollection.submissions ?? []),
    tasksSubmitted: selectTasksSubmittedFeed(tasks),
    tasksProof: selectTasksProofFeed(tasks),
    leaveRequests: selectLeaveFeed(rowsByCollection.leave_requests ?? []),
    applications: selectApplicationsFeed(rowsByCollection.applications ?? []),
  };
}

/**
 * universal-review GET replication: where('status','==',status) unless
 * status is 'all', then orderBy('submittedAt','desc') + limit(100).
 * Firestore orderBy again EXCLUDES docs missing submittedAt; the
 * route's existing catch-fallback (unindexed fetch) only runs when the
 * indexed query throws, which a successful Supabase read does not.
 */
export function selectUniversalReviewGet(
  rows: SupaRow[],
  status: string,
  limitCount = 100,
): SupaRow[] {
  const filtered =
    status === 'all' ? [...rows] : rows.filter((r) => r.data?.status === status);
  const kept = filtered.filter((r) => hasStoredField(r.data, 'submittedAt'));
  kept.sort((a, b) => {
    const am = supaTimestampToMillis(a.data?.submittedAt) ?? Number.NEGATIVE_INFINITY;
    const bm = supaTimestampToMillis(b.data?.submittedAt) ?? Number.NEGATIVE_INFINITY;
    if (bm !== am) return bm - am;
    return byIdAsc(b, a);
  });
  return kept.slice(0, limitCount);
}

// ---------------------------------------------------------------------------
// Mirror-write serialization (Firestore values -> jsonb values)
// ---------------------------------------------------------------------------

/**
 * Deep-convert a document partial being written to Firestore into the
 * JSON shape stored in fs_<collection>.data:
 *  - Firestore Timestamp-like values (toDate()) -> ISO strings
 *  - serverTimestamp() sentinels (web _methodName or Admin-SDK shape)
 *    -> the current instant as an ISO string. Firestore resolves the
 *    sentinel on its own server when the primary write lands; the
 *    mirror stamps this process's instant for the same write, so the
 *    two can differ by sub-second clock skew. Firestore stays primary.
 *  - FieldValue.increment / arrayUnion / delete sentinels have no jsonb
 *    form and are dropped (undefined) by the caller-visible contract:
 *    mirror partials for the inbox are status/review fields only.
 *  - Date instances and { _seconds, _nanoseconds } shapes -> ISO
 *  - everything else recurses (plain objects, arrays) or passes through.
 * Never throws: mirroring must not break the primary write path.
 */
export function serializeInboxForSupa(data: any): any {
  try {
    return serializeValue(data);
  } catch {
    return data;
  }
}

function serializeValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return supaTimestampToIso(value);
  if (typeof value?.toDate === 'function') return supaTimestampToIso(value);
  const method = (value as any)?._methodName;
  if (method === 'serverTimestamp') return new Date().toISOString();
  if (typeof method === 'string') return null; // other web-SDK sentinels
  // Admin SDK FieldValue sentinels carry a _delegate / operand shape with
  // no public marker; serverTimestamp() from firebase-admin exposes
  // `isEqual` only. The route builds mirror payloads with reviewedAt
  // already replaced by an ISO string, so no Admin sentinel should reach
  // here; anything unrecognized that is not a plain object is passed
  // through the plain-object recursion below.
  const seconds = (value as any)?._seconds ?? (value as any)?.seconds;
  if (typeof seconds === 'number' && Object.keys(value).length <= 3) {
    return supaTimestampToIso(value);
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
  return out;
}

// ---------------------------------------------------------------------------
// ADAPTER BRIDGE (server-only; re-point at src/lib/supa at merge time)
// ---------------------------------------------------------------------------

const SUPA_LIST_CAP = 1000;

function tableForCollection(collection: string): string {
  return `fs_${collection.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

async function supaRest(
  config: SupaServerConfig,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase REST ${res.status} on ${path.split('?')[0]}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** adapter listDocs(collection) — every row, id-ordered for determinism. */
export async function supaListInboxSourceRows(
  config: SupaServerConfig,
  collection: string,
): Promise<SupaRow[]> {
  const params = new URLSearchParams({
    select: 'id,data',
    order: 'id.asc',
    limit: String(SUPA_LIST_CAP),
  });
  const rows = await supaRest(config, `${tableForCollection(collection)}?${params}`);
  return Array.isArray(rows) ? rows : [];
}

/** All five inbox feeds from Supabase, selectors applied. Throws on error. */
export async function supaFetchInboxFeeds(config: SupaServerConfig): Promise<InboxFeeds> {
  const [submissions, tasks, leaveRequests, applications] = await Promise.all([
    supaListInboxSourceRows(config, 'submissions'),
    supaListInboxSourceRows(config, 'tasks'),
    supaListInboxSourceRows(config, 'leave_requests'),
    supaListInboxSourceRows(config, 'applications'),
  ]);
  return selectInboxFeeds({
    submissions,
    tasks,
    leave_requests: leaveRequests,
    applications,
  });
}

async function supaGetInboxDocData(
  config: SupaServerConfig,
  collection: string,
  id: string,
): Promise<Record<string, any> | null> {
  const params = new URLSearchParams({ select: 'data', id: `eq.${id}`, limit: '1' });
  const rows = await supaRest(config, `${tableForCollection(collection)}?${params}`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows[0]?.data ?? null) as Record<string, any> | null;
}

/** adapter setDoc(collection, id, data) — upsert the full row. */
export async function supaSetInboxDoc(
  config: SupaServerConfig,
  collection: string,
  id: string,
  data: Record<string, any>,
): Promise<void> {
  await supaRest(config, tableForCollection(collection), {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([
      { id, firebase_uid: null, parent_path: collection, data },
    ]),
  });
}

/**
 * adapter updateDoc(collection, id, partial) — shallow-merge the partial
 * into the stored row. Returns false (and writes nothing) when the row
 * does not exist: a partial-only row would surface in reads missing its
 * other fields, which is worse than a stale mirror.
 */
export async function supaUpdateInboxDoc(
  config: SupaServerConfig,
  collection: string,
  id: string,
  partial: Record<string, any>,
): Promise<boolean> {
  const existing = await supaGetInboxDocData(config, collection, id);
  if (existing === null) return false;
  await supaSetInboxDoc(config, collection, id, { ...existing, ...partial });
  return true;
}

/**
 * Best-effort mirror of one universal-review mutation into Supabase.
 * Never throws and never blocks the primary (Firestore) outcome: flag
 * OFF or Supabase unconfigured is a silent skip, and any error is only
 * logged. The caller passes a plain payload (serverTimestamp fields
 * already replaced with ISO strings by the caller, or handled by
 * serializeInboxForSupa for web-SDK-shaped values).
 */
export async function mirrorUniversalReviewToSupa(
  collection: string,
  id: string,
  payload: Record<string, any>,
): Promise<void> {
  if (!inboxSupaServerEnabled()) return;
  const config = getInboxSupaServerConfig();
  if (!config) return;
  try {
    await supaUpdateInboxDoc(config, collection, id, serializeInboxForSupa(payload));
  } catch (err) {
    console.error('[inbox-supa] mirror failed', collection, id, err);
  }
}

// ---------------------------------------------------------------------------
// Client route fetchers (browser -> this app's API routes)
// ---------------------------------------------------------------------------

/** The signed-in user's ID token, or null. Never throws. */
export async function getInboxUserIdToken(): Promise<string | null> {
  try {
    const [{ getAuth }, { getFirebaseApp }] = await Promise.all([
      import('firebase/auth'),
      import('@/firebase/provider'),
    ]);
    const current = getAuth(getFirebaseApp()).currentUser;
    return current ? await current.getIdToken() : null;
  } catch {
    return null;
  }
}

let sharedFeedsPromise: Promise<InboxFeeds> | null = null;
let sharedFeedsAt = 0;
const SHARED_FEEDS_TTL_MS = 2000;

/**
 * Fetch all five inbox feeds from GET /api/admin/universal-review
 * ?inboxFeeds=1. Throws on any failure (route disabled/unconfigured,
 * network, non-OK status) so every caller falls back to its Firestore
 * listener. Concurrent callers within a short window share one fetch:
 * the page's five feed loaders and one poll tick must not fan out into
 * five identical requests.
 */
export async function fetchInboxFeedsViaRoute(): Promise<InboxFeeds> {
  const now = Date.now();
  if (sharedFeedsPromise && now - sharedFeedsAt < SHARED_FEEDS_TTL_MS) {
    return sharedFeedsPromise;
  }
  const promise = (async (): Promise<InboxFeeds> => {
    const token = await getInboxUserIdToken();
    const res = await fetch('/api/admin/universal-review?inboxFeeds=1', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`inbox supa route ${res.status}`);
    const body = await res.json();
    const feeds = body?.feeds ?? {};
    return {
      submissions: Array.isArray(feeds.submissions) ? feeds.submissions : [],
      tasksSubmitted: Array.isArray(feeds.tasksSubmitted) ? feeds.tasksSubmitted : [],
      tasksProof: Array.isArray(feeds.tasksProof) ? feeds.tasksProof : [],
      leaveRequests: Array.isArray(feeds.leaveRequests) ? feeds.leaveRequests : [],
      applications: Array.isArray(feeds.applications) ? feeds.applications : [],
    };
  })();
  sharedFeedsPromise = promise;
  sharedFeedsAt = now;
  promise.catch(() => {
    if (sharedFeedsPromise === promise) sharedFeedsPromise = null;
  });
  return promise;
}
