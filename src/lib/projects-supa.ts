/**
 * Projects -> Supabase seam (Supabase migration, cluster I / step 10).
 * See ~/workspace/supabase-migration/CLUSTER_MAP.md cluster I and
 * MERGE_PLAN.md step 10 + conflict C-14.
 *
 * EVERY Supabase touch for the `projects` surface lives in this one
 * module, following the announcements seam's shape
 * (src/lib/announcements-supa.ts). The server bridge in the "ADAPTER
 * BRIDGE" section runs on the shipped adapter (src/lib/supa/):
 *
 *   supaListProjectRows        <->  adapter listDocs('projects')
 *   supaGetProjectRow          <->  adapter getDoc('projects', id)
 *   supaFindProjectBySlugOrId  <->  getDoc, then listDocs(slug == x, limit 1)
 *   supaSetProject             <->  adapter setDoc('projects', id, data)
 *   supaUpdateProject          <->  adapter updateDoc('projects', id, partial)
 *   supaDeleteProject          <->  adapter deleteDoc('projects', id)
 *   projectsSupaServerEnabled() <->  adapter useSupa('projects')
 *   projectsSupaClientEnabled() <->  NEXT_PUBLIC_ twin of the same
 *
 * The adapter is loaded through a dynamic import inside the bridge:
 * this module is also imported by browser code (projects-cached, the
 * project hooks, the projects pages), and the adapter's service-role
 * client must never enter a client bundle. The flag helper's import
 * (./supa/flags) is dependency-free and safe on both sides.
 *
 * Flag names are frozen by the adapter (MERGE_PLAN rule 7): server
 * code reads SUPA_SURFACES; browser code can only see the
 * NEXT_PUBLIC_ twin, NEXT_PUBLIC_SUPA_SURFACES, which rollout sets to
 * the same value. Both must name 'projects' for the surface to be
 * live: the client uses its flag as a hint to try the API routes, and
 * each route re-checks the server flag (and the adapter config)
 * before serving anything, so a stale or forged client hint can
 * never widen access.
 *
 * Fallback contract (identical for every consumer): flag OFF,
 * Supabase unconfigured, route missing, or ANY error -> the caller
 * behaves exactly as it does on Firestore today. Nothing in this
 * module throws into a write path; read helpers throw only so the
 * caller can fall back to its Firestore code path. Mirror helpers
 * never throw at all.
 *
 * Timestamp reality of the fs_projects jsonb column: Firestore
 * Timestamp objects do not survive JSON. Depending on the producer a
 * stored timestamp is an ISO string (this module's mirror writes and
 * the adapter's own writes), an Admin-SDK dump object
 * ({ _seconds, _nanoseconds } or { seconds, nanoseconds }), or an
 * epoch number. The adapter rehydrates the dumped shape into a
 * SupaTimestamp server-side; over the route's JSON it arrives as
 * { _seconds, _nanoseconds }. projectTimestampToIso /
 * restoreProjectTimestamps normalize every one of those shapes for
 * consumers whose code expects ISO strings or Timestamp instances.
 */

import { useSupa } from './supa/flags';
import type { SupaAdapter, WhereClause } from './supa/adapter';

// ---------------------------------------------------------------------------
// Flags (adapter useSupa('projects') + its NEXT_PUBLIC_ twin)
// ---------------------------------------------------------------------------

export const PROJECTS_SUPA_SURFACE = 'projects';
export const PROJECTS_COLLECTION = 'projects';

/**
 * Parse the client-visible surface list (NEXT_PUBLIC_SUPA_SURFACES):
 * comma-separated, trimmed, lowercased, empties dropped; '*' means
 * every surface. Mirrors the announcements seam's parser.
 */
export function parseProjectsClientSurfaces(
  raw: string | undefined,
): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Server-side flag: the adapter's useSupa over SUPA_SURFACES. */
export function projectsSupaServerEnabled(): boolean {
  return useSupa(PROJECTS_SUPA_SURFACE);
}

/**
 * Client-side hint: the NEXT_PUBLIC_ twin of SUPA_SURFACES, parsed
 * the same way. Only a hint to attempt the API routes; the routes
 * re-check the server flag.
 */
export function projectsSupaClientEnabled(): boolean {
  const surfaces = parseProjectsClientSurfaces(
    process.env.NEXT_PUBLIC_SUPA_SURFACES,
  );
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(PROJECTS_SUPA_SURFACE);
}

// ---------------------------------------------------------------------------
// Timestamp normalization (jsonb reality)
// ---------------------------------------------------------------------------

/** Project fields that carry Firestore timestamps when stored. */
export const PROJECT_TIMESTAMP_FIELDS = [
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'started_at',
  'completed_at',
] as const;

/**
 * Normalize any stored timestamp representation to an ISO string.
 * Returns null for null/undefined/unparseable values.
 *
 * Accepts: ISO (or otherwise Date-parseable) strings, epoch numbers,
 * Date instances, Firestore Timestamp-like objects (toDate()), the
 * adapter's SupaTimestamp shape (toDate()/toMillis()), and the Admin
 * SDK JSON shapes { _seconds, _nanoseconds } / { seconds,
 * nanoseconds } that migrate_db.js dumps into jsonb.
 */
export function projectTimestampToIso(value: any): string | null {
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
    if (typeof value?.toMillis === 'function') {
      const ms = value.toMillis();
      const d = new Date(ms);
      return typeof ms === 'number' && !isNaN(d.getTime())
        ? d.toISOString()
        : null;
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

export function projectDateMs(value: any): number | null {
  const iso = projectTimestampToIso(value);
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * Convert the timestamp fields of a raw jsonb document body back
 * into Firestore Timestamp instances so consumers whose mapping
 * calls .toDate() / .toMillis() / reads .seconds run unchanged. The
 * Timestamp factory is injected so this module stays free of a
 * firebase/firestore value import: callers pass
 * (d) => Timestamp.fromDate(d).
 */
export function restoreProjectTimestamps(
  data: Record<string, any>,
  makeTimestamp: (d: Date) => any,
): Record<string, any> {
  const out = { ...data };
  for (const field of PROJECT_TIMESTAMP_FIELDS) {
    if (out[field] === undefined || out[field] === null) continue;
    const iso = projectTimestampToIso(out[field]);
    if (iso !== null) out[field] = makeTimestamp(new Date(iso));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mirror-write serialization (Firestore values -> jsonb values)
// ---------------------------------------------------------------------------

/**
 * Deep-convert a project document being written to Firestore into
 * the JSON shape stored in fs_projects.data:
 *  - Firestore Timestamp-like values (toDate()) -> ISO strings
 *  - serverTimestamp() sentinels -> the current instant as an ISO
 *    string. Firestore resolves the sentinel on its own server when
 *    the primary write lands; the mirror stamps the client's instant
 *    for the same write, so the two can differ by sub-second clock
 *    skew. Firestore stays primary; this only affects the read copy.
 *  - Date instances and { _seconds, _nanoseconds } shapes -> ISO
 *  - everything else recurses (plain objects, arrays) or passes
 *    through.
 * Never throws: mirroring must not break the primary write path.
 */
export function serializeProjectForSupa(data: any): any {
  try {
    return serializeValue(data);
  } catch {
    return data;
  }
}

function serializeValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return projectTimestampToIso(value);
  if (typeof value?.toDate === 'function') return projectTimestampToIso(value);
  // FieldValue sentinels from the web SDK carry a _methodName.
  const method = (value as any)?._methodName;
  if (method === 'serverTimestamp') return new Date().toISOString();
  if (typeof method === 'string') return null; // other sentinels have no jsonb form
  const seconds = (value as any)?._seconds ?? (value as any)?.seconds;
  if (typeof seconds === 'number' && Object.keys(value).length <= 3) {
    return projectTimestampToIso(value);
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
  return out;
}

// ---------------------------------------------------------------------------
// Visibility + list selection (pure replication of the Firestore queries)
// ---------------------------------------------------------------------------

/** A flat project document as the adapter and the routes serve it. */
export type ProjectSupaDoc = { id: string } & Record<string, any>;

/** Statuses the guest queries on /projects and useProjects allow. */
export const PUBLIC_PROJECT_STATUSES = ['published', 'active', 'completed'];

/**
 * The guest-visible predicate, replicating the two client query
 * shapes in the tree: the status query
 * (where('status', 'in', ['published', 'active', 'completed'])) used
 * by src/app/projects/page.tsx and src/hooks/use-projects.ts for
 * signed-out viewers, and the legacy boolean fallback
 * (where('published', '==', true)) the public page runs when the
 * status query returns nothing.
 */
export function isPubliclyVisibleProject(data: Record<string, any>): boolean {
  if (typeof data?.status === 'string' && PUBLIC_PROJECT_STATUSES.includes(data.status)) {
    return true;
  }
  return data?.published === true;
}

export interface ProjectListSelection {
  /** 'guest' applies isPubliclyVisibleProject; 'member' serves all. */
  viewer?: 'guest' | 'member';
  /** useFeaturedProjects: where('published', '==', true). */
  publishedOnly?: boolean;
  /** useProjects featuredOnly: where('showOnHomepage', '==', true). */
  featuredOnly?: boolean;
  /** useFeaturedProjects: where('featured_on_recruitment_page', '==', true). */
  featuredOnRecruitment?: boolean;
  /** useFeaturedProjects: where('featured_on_sponsorship_page', '==', true). */
  featuredOnSponsorship?: boolean;
  /** useFeaturedProjects: where('category', '==', category). */
  category?: string;
  /** Applied last, exactly where the Firestore queries apply limit(). */
  limit?: number;
}

/**
 * Apply one consumer's Firestore query semantics to flat adapter
 * docs, in the queries' own order: equality/status filters first,
 * limit() last. No sorting happens here — every consumer that sorts
 * (useProjects, the public page) already sorts client-side after
 * the fetch, on both backends.
 */
export function selectProjectList(
  docs: ProjectSupaDoc[],
  selection: ProjectListSelection = {},
): ProjectSupaDoc[] {
  let out = docs;
  if (selection.viewer === 'guest') {
    out = out.filter((d) => isPubliclyVisibleProject(d));
  }
  if (selection.publishedOnly) {
    out = out.filter((d) => d.published === true);
  }
  if (selection.featuredOnly) {
    out = out.filter((d) => d.showOnHomepage === true);
  }
  if (selection.featuredOnRecruitment) {
    out = out.filter((d) => d.featured_on_recruitment_page === true);
  }
  if (selection.featuredOnSponsorship) {
    out = out.filter((d) => d.featured_on_sponsorship_page === true);
  }
  if (selection.category) {
    out = out.filter((d) => d.category === selection.category);
  }
  if (selection.limit !== undefined && selection.limit >= 0) {
    out = out.slice(0, selection.limit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ADAPTER BRIDGE (server-only; runs on src/lib/supa)
// ---------------------------------------------------------------------------

/**
 * Test seam, following the announcements seam's
 * __setSupaAdapterForTests pattern: when set, the bridge uses the
 * injected adapter instead of the env-configured default. Passing
 * null forces "no adapter" (every bridge call rejects, exactly as an
 * unconfigured getSupaAdapter() does); passing undefined restores the
 * default. Production code never calls this.
 */
let adapterOverride: SupaAdapter | null | undefined;

export function __setSupaAdapterForTests(
  adapter: SupaAdapter | null | undefined,
): void {
  adapterOverride = adapter;
}

async function loadAdapter(): Promise<SupaAdapter> {
  if (adapterOverride !== undefined) {
    if (!adapterOverride) {
      throw new Error('Supabase adapter unavailable (forced off by the test seam)');
    }
    return adapterOverride;
  }
  // Dynamic import on purpose: this module ships in browser bundles
  // (via projects-cached and the hooks) and the adapter pulls in the
  // service-role client, which is server-only. The bridge functions
  // themselves are only ever called from route handlers.
  const { getSupaAdapter } = await import('./supa');
  return getSupaAdapter();
}

/**
 * The adapter returns Firestore-shaped flat docs ({ id, ...data });
 * the seam's row contract is { id, data }. The document body is the
 * flat doc minus its id: a stored 'id' field inside the body never
 * survives this split, so the column id always wins.
 */
function rowFromAdapterDoc(doc: {
  id: string;
  [key: string]: any;
}): { id: string; data: any } {
  const { id, ...data } = doc;
  return { id, data };
}

function docFromRow(row: { id: string; data: any }): ProjectSupaDoc {
  return { ...(row.data ?? {}), id: row.id } as ProjectSupaDoc;
}

/** listDocs('projects') — every row, as { id, data } rows. */
export async function supaListProjectRows(): Promise<
  Array<{ id: string; data: any }>
> {
  const adapter = await loadAdapter();
  const docs = await adapter.listDocs(PROJECTS_COLLECTION);
  return docs.map(rowFromAdapterDoc);
}

/** listDocs('projects') — every row, as flat { id, ...data } docs. */
export async function supaListProjects(): Promise<ProjectSupaDoc[]> {
  const rows = await supaListProjectRows();
  return rows.map(docFromRow);
}

/** getDoc('projects', id) — one flat doc, or null. */
export async function supaGetProject(id: string): Promise<ProjectSupaDoc | null> {
  const adapter = await loadAdapter();
  const doc = await adapter.getDoc(PROJECTS_COLLECTION, id);
  return doc ? (doc as ProjectSupaDoc) : null;
}

/**
 * The getProjectBySlugOrId lookup order, replicated exactly: a
 * direct document-id get first (its errors are swallowed by the
 * Firestore original, so a getDoc failure here also falls through
 * to the slug query), then listDocs(slug == x, limit 1).
 */
export async function supaFindProjectBySlugOrId(
  slugOrId: string,
): Promise<ProjectSupaDoc | null> {
  if (!slugOrId) return null;
  try {
    const direct = await supaGetProject(slugOrId);
    if (direct) return direct;
  } catch {
    // ignore and fall back to the slug query (Firestore original)
  }
  const adapter = await loadAdapter();
  const where: WhereClause[] = [['slug', '==', slugOrId]];
  const rows = await adapter.listDocs(PROJECTS_COLLECTION, { where, limit: 1 });
  return rows.length > 0 ? (rows[0] as ProjectSupaDoc) : null;
}

/** setDoc('projects', id, data) — upsert the full row. */
export async function supaSetProject(
  id: string,
  data: Record<string, any>,
): Promise<void> {
  const adapter = await loadAdapter();
  await adapter.setDoc(PROJECTS_COLLECTION, id, data);
}

/**
 * updateDoc('projects', id, partial) — merge the partial into the
 * stored row. Returns false (and writes nothing) when the row does
 * not exist: a partial-only row would surface in reads missing its
 * other fields, which is worse than a stale mirror; the bulk
 * re-sync heals such rows. (The adapter's own updateDoc would
 * reject on a missing doc; the existence pre-check keeps this
 * seam's boolean contract instead.)
 */
export async function supaUpdateProject(
  id: string,
  partial: Record<string, any>,
): Promise<boolean> {
  const existing = await supaGetProject(id);
  if (existing === null) return false;
  const adapter = await loadAdapter();
  await adapter.updateDoc(PROJECTS_COLLECTION, id, partial);
  return true;
}

/** deleteDoc('projects', id). */
export async function supaDeleteProject(id: string): Promise<void> {
  const adapter = await loadAdapter();
  await adapter.deleteDoc(PROJECTS_COLLECTION, id);
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

function listQueryString(selection: ProjectListSelection): string {
  const params = new URLSearchParams();
  if (selection.publishedOnly) params.set('published', '1');
  if (selection.featuredOnly) params.set('featured', '1');
  if (selection.featuredOnRecruitment) params.set('featuredOnRecruitment', '1');
  if (selection.featuredOnSponsorship) params.set('featuredOnSponsorship', '1');
  if (selection.category) params.set('category', selection.category);
  if (selection.limit !== undefined) params.set('limit', String(selection.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Fetch a project list from GET /api/projects. The route resolves
 * the viewer tier from the presented token (token -> member, none ->
 * guest) and applies the selection server-side. Throws on any
 * failure (route disabled/unconfigured, network, auth) so the
 * caller falls back to its Firestore path.
 */
export async function fetchProjectsViaRoute(
  selection: ProjectListSelection = {},
): Promise<ProjectSupaDoc[]> {
  const token = await getCurrentUserIdToken();
  const res = await fetch(`/api/projects${listQueryString(selection)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`projects route ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.projects) ? body.projects : [];
}

/**
 * Fetch one project from GET /api/projects?slugOrId=. Returns null
 * when the route is live but holds no such project (the caller
 * decides whether a miss falls back to Firestore). Throws on any
 * failure so the caller falls back to its Firestore path.
 */
export async function fetchProjectBySlugOrIdViaRoute(
  slugOrId: string,
): Promise<ProjectSupaDoc | null> {
  const token = await getCurrentUserIdToken();
  const res = await fetch(
    `/api/projects?slugOrId=${encodeURIComponent(slugOrId)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!res.ok) throw new Error(`projects route ${res.status}`);
  const body = await res.json();
  return (body?.project ?? null) as ProjectSupaDoc | null;
}

/** Raw fs_projects rows for the admin list (admin route). Throws. */
export async function fetchAdminProjectRowsViaRoute(
  idToken: string,
): Promise<Array<{ id: string; data: any }>> {
  const res = await fetch('/api/admin/projects/supa', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`admin projects supa route ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.rows) ? body.rows : [];
}

export type ProjectMirrorOp = 'set' | 'update' | 'delete';

/**
 * Mirror one project write into fs_projects through
 * POST /api/admin/projects/supa. Best-effort by contract: never
 * throws, never blocks the primary (Firestore) write's outcome. A
 * null token skips silently.
 */
export async function mirrorProjectViaRoute(
  idToken: string | null,
  op: ProjectMirrorOp,
  id: string,
  data?: Record<string, any>,
): Promise<void> {
  if (!idToken) return;
  try {
    await fetch('/api/admin/projects/supa', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        op,
        id,
        data: data ? serializeProjectForSupa(data) : undefined,
      }),
    });
  } catch (err) {
    // Firestore is primary; a missed mirror is a stale read copy,
    // not a failed write. Logged so the re-sync can be audited.
    console.error('[projects-supa] mirror failed', op, id, err);
  }
}

/**
 * Best-effort mirror for writers that hold no admin-route token
 * contract of their own (the public /projects/new create path goes
 * through addProjectClient): resolves the current user's token
 * itself and mirrors a full-document 'set'. Never throws.
 */
export async function mirrorProjectCreateBestEffort(
  id: string,
  data: Record<string, any>,
): Promise<void> {
  try {
    const token = await getCurrentUserIdToken();
    await mirrorProjectViaRoute(token, 'set', id, data);
  } catch (err) {
    console.error('[projects-supa] create mirror failed', id, err);
  }
}
