/**
 * Announcements -> Supabase seam (Supabase resilience program, Phase 2,
 * cluster A: announcements). See ~/workspace/supabase-migration/
 * RESILIENCE_PLAN.md (Phase 2 order, item 1) and MERGE_PLAN.md step 2.
 *
 * EVERY Supabase touch for the announcements surface lives in this one
 * module, so the merge step can re-point the seam at the real adapter
 * (src/lib/supa/, branch feat/supa-adapter) with edits confined to the
 * "ADAPTER BRIDGE" section below plus the two flag helpers:
 *
 *   supaListPublishedAnnouncementRows  <->  adapter listDocs('announcements', published)
 *   supaListAnnouncementRows           <->  adapter listDocs('announcements')
 *   supaSetAnnouncement                <->  adapter setDoc('announcements', id, data)
 *   supaUpdateAnnouncement             <->  adapter updateDoc('announcements', id, partial)
 *   supaDeleteAnnouncement             <->  adapter deleteDoc('announcements', id)
 *   announcementsSupa*Enabled()        <->  adapter useSupa('announcements')
 *
 * Until the adapter lands, the bridge speaks PostgREST directly with
 * fetch (the adapter branch owns the @supabase/supabase-js dependency;
 * MERGE_PLAN rule 4 forbids other branches from touching package.json).
 *
 * Flag names are frozen by the adapter (MERGE_PLAN rule 7): the surface
 * list env is SUPA_SURFACES (comma-separated surface names). Server code
 * reads SUPA_SURFACES; browser code can only see the NEXT_PUBLIC_ twin,
 * NEXT_PUBLIC_SUPA_SURFACES, which rollout sets to the same value. Both
 * must name 'announcements' for the surface to be live: the client uses
 * its flag as a hint to try the API routes, and each route re-checks the
 * server flag (and the server config) before serving anything, so a
 * stale or forged client hint can never widen access.
 *
 * Fallback contract (identical for every consumer): flag OFF, Supabase
 * unconfigured, route missing, or ANY error -> the caller behaves
 * exactly as it does on Firestore today. Nothing in this module throws
 * into a write path; read helpers throw only so the caller can fall
 * back to its Firestore code path.
 *
 * Timestamp reality of the fs_announcements jsonb column: Firestore
 * Timestamp objects do not survive JSON. Depending on the producer a
 * stored timestamp is an ISO string (this module's mirror writes), an
 * Admin-SDK dump object ({ _seconds, _nanoseconds } or { seconds,
 * nanoseconds }, from migrate_db.js JSON.stringify of doc.data()), or
 * an epoch number. supaTimestampToIso normalizes every one of those to
 * an ISO string, the form every announcements consumer already parses
 * (AnnouncementDoc types these fields as "Timestamp or ISO string").
 */

import type {
  AnnouncementDoc,
  VisibleAnnouncementQueryOptions,
} from './announcements';

// ---------------------------------------------------------------------------
// Flags (re-point at adapter useSupa('announcements') at merge time)
// ---------------------------------------------------------------------------

const SURFACE = 'announcements';

function surfaceListHas(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(SURFACE);
}

/** Server-side flag: the SUPA_SURFACES env frozen by the adapter. */
export function announcementsSupaServerEnabled(): boolean {
  return surfaceListHas(process.env.SUPA_SURFACES);
}

/**
 * Client-side hint: the NEXT_PUBLIC_ twin of SUPA_SURFACES. Only a hint
 * to attempt the API routes; the routes re-check the server flag.
 */
export function announcementsSupaClientEnabled(): boolean {
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
 * The Supabase server config, or null when unconfigured. Reads the
 * frozen env names (MERGE_PLAN rule 7). Server-only: the service role
 * key must never reach a browser bundle, so this reads non-public env
 * vars (undefined in client bundles) and its callers are route handlers.
 */
export function getSupaServerConfig(): SupaServerConfig | null {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

// ---------------------------------------------------------------------------
// Timestamp normalization (jsonb reality)
// ---------------------------------------------------------------------------

/** Announcement fields that carry Firestore timestamps when stored. */
export const ANNOUNCEMENT_TIMESTAMP_FIELDS = [
  'publish_date',
  'expiresAt',
  'updated_at',
  'created_at',
] as const;

/**
 * Normalize any stored timestamp representation to an ISO string.
 * Returns null for null/undefined/unparseable values.
 *
 * Accepts: ISO (or otherwise Date-parseable) strings, epoch numbers,
 * Date instances, Firestore Timestamp-like objects (toDate()), and the
 * Admin SDK JSON shapes { _seconds, _nanoseconds } / { seconds,
 * nanoseconds } that migrate_db.js dumps into jsonb.
 */
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

function supaDateMs(value: any): number | null {
  const iso = supaTimestampToIso(value);
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Convert one fs_announcements row ({ id, data }) into the
 * AnnouncementDoc shape the Firestore converter produces: the document
 * fields spread with the column id winning, and the timestamp fields
 * normalized to ISO strings. publish_date mirrors the Firestore
 * converter: always present, null when absent.
 */
export function announcementDocFromSupaRow(row: {
  id: string;
  data: any;
}): AnnouncementDoc {
  const data = (row?.data ?? {}) as Record<string, any>;
  const doc: Record<string, any> = { ...data, id: row.id };
  for (const field of ANNOUNCEMENT_TIMESTAMP_FIELDS) {
    if (field === 'publish_date') {
      doc.publish_date = supaTimestampToIso(data.publish_date);
    } else if (data[field] !== undefined) {
      doc[field] = supaTimestampToIso(data[field]);
    }
  }
  // Converter default (C-SHP-02): a stored doc without priority reads
  // back 0, exactly as announcementConverter.fromFirestore produces.
  doc.priority = data.priority ?? 0;
  return doc as AnnouncementDoc;
}

/**
 * The client-side inverse for the admin list: convert the timestamp
 * fields of a raw jsonb row back into Firestore Timestamp instances so
 * the admin page's existing BroadcastItem mapping (which calls
 * .toDate() / .toMillis()) runs unchanged. The Timestamp factory is
 * injected so this module stays free of a firebase/firestore value
 * import: the page passes (d) => Timestamp.fromDate(d).
 */
export function restoreAnnouncementTimestamps(
  data: Record<string, any>,
  makeTimestamp: (d: Date) => any,
): Record<string, any> {
  const out = { ...data };
  for (const field of ANNOUNCEMENT_TIMESTAMP_FIELDS) {
    if (out[field] === undefined || out[field] === null) continue;
    const iso = supaTimestampToIso(out[field]);
    if (iso !== null) out[field] = makeTimestamp(new Date(iso));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mirror-write serialization (Firestore values -> jsonb values)
// ---------------------------------------------------------------------------

/**
 * Deep-convert an announcement document being written to Firestore
 * into the JSON shape stored in fs_announcements.data:
 *  - Firestore Timestamp-like values (toDate()) -> ISO strings
 *  - serverTimestamp() sentinels -> the current instant as an ISO
 *    string. Firestore resolves the sentinel on its own server when
 *    the primary write lands; the mirror stamps the client's instant
 *    for the same write, so the two can differ by sub-second clock
 *    skew. Firestore stays primary; this only affects the read copy.
 *  - Date instances and { _seconds, _nanoseconds } shapes -> ISO
 *  - everything else recurses (plain objects, arrays) or passes through.
 * Never throws: mirroring must not break the primary write path.
 */
export function serializeAnnouncementForSupa(data: any): any {
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
  // FieldValue sentinels from the web SDK carry a _methodName.
  const method = (value as any)?._methodName;
  if (method === 'serverTimestamp') return new Date().toISOString();
  if (typeof method === 'string') return null; // other sentinels have no jsonb form
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
// Visible-set selection (pure replication of the Firestore split queries)
// ---------------------------------------------------------------------------

/**
 * Replicates, over fs_announcements rows, the exact candidate set the
 * Firestore split queries in visibleAnnouncementQueries produce: for
 * each audience value (in the viewer's tier order), documents with
 * status 'published', that audience value, and publish_date <= now
 * (absent/null publish_date matches NO split query, exactly as in
 * Firestore, so such documents are excluded here too), ordered by
 * updated_at descending, capped per value, merged with first-win
 * dedupe by id. Expiry is deliberately NOT filtered here: the split
 * queries do not filter it either; consumers apply
 * isAnnouncementVisibleTo afterwards, unchanged.
 *
 * Ordering ties: Firestore breaks orderBy ties by document id in the
 * query direction (descending here); null/missing updated_at sorts as
 * the lowest value, last in descending order.
 */
export function selectVisibleAnnouncements(
  rows: Array<{ id: string; data: any }>,
  audienceValues: string[],
  options: VisibleAnnouncementQueryOptions = {},
  now?: Date | number,
): AnnouncementDoc[] {
  const nowMs =
    now === undefined || now === null
      ? Date.now()
      : now instanceof Date
        ? now.getTime()
        : new Date(now).getTime();
  const docs = rows.map(announcementDocFromSupaRow);
  const merged = new Map<string, AnnouncementDoc>();
  for (const value of audienceValues) {
    const candidates = docs.filter((d) => {
      if (d.status !== 'published') return false;
      if (d.audience !== value) return false;
      if (options.isFeatured && d.isFeatured !== true) return false;
      const publishMs = supaDateMs(d.publish_date);
      if (publishMs === null) return false; // matches no split query
      return publishMs <= nowMs;
    });
    candidates.sort((a, b) => {
      const am = supaDateMs(a.updated_at) ?? Number.NEGATIVE_INFINITY;
      const bm = supaDateMs(b.updated_at) ?? Number.NEGATIVE_INFINITY;
      if (bm !== am) return bm - am;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const limited = options.limitCount
      ? candidates.slice(0, options.limitCount)
      : candidates;
    for (const d of limited) {
      if (!merged.has(d.id)) merged.set(d.id, d);
    }
  }
  return Array.from(merged.values());
}

// ---------------------------------------------------------------------------
// ADAPTER BRIDGE (server-only; re-point at src/lib/supa at merge time)
// ---------------------------------------------------------------------------

const FS_ANNOUNCEMENTS_TABLE = 'fs_announcements';
const SUPA_LIST_CAP = 1000;

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

/** listDocs('announcements') — every row, id-ordered for determinism. */
export async function supaListAnnouncementRows(
  config: SupaServerConfig,
): Promise<Array<{ id: string; data: any }>> {
  const params = new URLSearchParams({
    select: 'id,data',
    order: 'id.asc',
    limit: String(SUPA_LIST_CAP),
  });
  const rows = await supaRest(config, `${FS_ANNOUNCEMENTS_TABLE}?${params}`);
  return Array.isArray(rows) ? rows : [];
}

/** listDocs('announcements', status = published) for the visible route. */
export async function supaListPublishedAnnouncementRows(
  config: SupaServerConfig,
): Promise<Array<{ id: string; data: any }>> {
  const params = new URLSearchParams({
    select: 'id,data',
    'data->>status': 'eq.published',
    order: 'id.asc',
    limit: String(SUPA_LIST_CAP),
  });
  const rows = await supaRest(config, `${FS_ANNOUNCEMENTS_TABLE}?${params}`);
  return Array.isArray(rows) ? rows : [];
}

/** setDoc('announcements', id, data) — upsert the full row. */
export async function supaSetAnnouncement(
  config: SupaServerConfig,
  id: string,
  data: Record<string, any>,
): Promise<void> {
  await supaRest(config, FS_ANNOUNCEMENTS_TABLE, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([
      { id, firebase_uid: null, parent_path: 'announcements', data },
    ]),
  });
}

async function supaGetAnnouncementData(
  config: SupaServerConfig,
  id: string,
): Promise<Record<string, any> | null> {
  const params = new URLSearchParams({
    select: 'data',
    id: `eq.${id}`,
    limit: '1',
  });
  const rows = await supaRest(config, `${FS_ANNOUNCEMENTS_TABLE}?${params}`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows[0]?.data ?? null) as Record<string, any> | null;
}

/**
 * updateDoc('announcements', id, partial) — shallow-merge the partial
 * into the stored row. Returns false (and writes nothing) when the row
 * does not exist: a partial-only row would surface in visible reads
 * missing its other fields, which is worse than a stale mirror; the
 * Phase 1/3 export refresh heals such rows.
 */
export async function supaUpdateAnnouncement(
  config: SupaServerConfig,
  id: string,
  partial: Record<string, any>,
): Promise<boolean> {
  const existing = await supaGetAnnouncementData(config, id);
  if (existing === null) return false;
  await supaSetAnnouncement(config, id, { ...existing, ...partial });
  return true;
}

/** deleteDoc('announcements', id). */
export async function supaDeleteAnnouncement(
  config: SupaServerConfig,
  id: string,
): Promise<void> {
  const params = new URLSearchParams({ id: `eq.${id}` });
  await supaRest(config, `${FS_ANNOUNCEMENTS_TABLE}?${params}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

// ---------------------------------------------------------------------------
// Client route fetchers (browser -> this app's API routes)
// ---------------------------------------------------------------------------

/** The signed-in user's ID token, or null. Never throws. */
export async function getCurrentUserIdToken(): Promise<string | null> {
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

export interface VisibleAnnouncementsRouteResult {
  docs: AnnouncementDoc[];
  audienceValues: string[];
}

/**
 * Fetch the visible set from GET /api/announcements/visible. Throws on
 * any failure (route disabled/unconfigured, network, tier mismatch) so
 * the caller falls back to its Firestore path. The tier guard compares
 * the audience values the server resolved against the ones the client
 * computed for its viewer: a mismatch means the server saw a lesser
 * viewer (e.g. an expired token resolved as anonymous), which must not
 * silently narrow what the user is entitled to see.
 */
export async function fetchVisibleAnnouncementsViaRoute(
  expectedAudienceValues: string[],
  options: VisibleAnnouncementQueryOptions = {},
  expectSignedIn = false,
): Promise<VisibleAnnouncementsRouteResult> {
  const token = await getCurrentUserIdToken();
  if (expectSignedIn && !token) {
    throw new Error('supa route requires a signed-in token');
  }
  const params = new URLSearchParams();
  if (options.limitCount) params.set('limit', String(options.limitCount));
  if (options.isFeatured) params.set('featured', '1');
  const qs = params.toString();
  const res = await fetch(`/api/announcements/visible${qs ? `?${qs}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`visible route ${res.status}`);
  const body = await res.json();
  const serverValues: string[] = Array.isArray(body?.audienceValues)
    ? body.audienceValues
    : [];
  const sortJoin = (v: string[]) => [...v].sort().join(',');
  if (sortJoin(serverValues) !== sortJoin(expectedAudienceValues)) {
    throw new Error('supa route resolved a different viewer tier');
  }
  const docs: AnnouncementDoc[] = Array.isArray(body?.announcements)
    ? body.announcements
    : [];
  return { docs, audienceValues: serverValues };
}

/** Raw fs_announcements rows for the admin list (admin route). Throws. */
export async function fetchAdminAnnouncementRowsViaRoute(
  idToken: string,
): Promise<Array<{ id: string; data: any }>> {
  const res = await fetch('/api/admin/announcements/supa', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`admin supa route ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.rows) ? body.rows : [];
}

export type AnnouncementMirrorOp = 'set' | 'update' | 'delete';

/**
 * Mirror one admin announcements write into fs_announcements through
 * POST /api/admin/announcements/supa. Best-effort by contract: never
 * throws, never blocks the primary (Firestore) write's outcome. A null
 * token skips silently.
 */
export async function mirrorAnnouncementViaRoute(
  idToken: string | null,
  op: AnnouncementMirrorOp,
  id: string,
  data?: Record<string, any>,
): Promise<void> {
  if (!idToken) return;
  try {
    await fetch('/api/admin/announcements/supa', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        op,
        id,
        data: data ? serializeAnnouncementForSupa(data) : undefined,
      }),
    });
  } catch (err) {
    // Firestore is primary; a missed mirror is a stale read copy, not
    // a failed write. Logged so the Phase 3 refresh can be audited.
    console.error('[announcements-supa] mirror failed', op, id, err);
  }
}
