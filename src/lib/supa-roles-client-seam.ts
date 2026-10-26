'use client';

/**
 * Supa seam for the roles/permissions client libraries (file-group 3:
 * admin roles UI + client role libraries).
 *
 * This is the ONLY module through which this group's client code can
 * reach Supabase-backed data, and it never talks to Supabase directly:
 * the browser has no Supabase client and no service key. When the
 * surface is enabled, reads/writes go to the thin server route
 * `POST/GET /api/roles/reads`, which alone imports the server adapter
 * (`src/lib/supa/`, branch feat/supa-adapter) behind
 * `useSupa('roles')`, falling back to Admin-SDK Firestore reads there.
 *
 * Flag: NEXT_PUBLIC_SUPA_SURFACES is the client-visible mirror of the
 * adapter's server-side SUPA_SURFACES vocabulary (comma list, `*` =
 * all, case-insensitive). The surface name for this group is `roles`.
 * Unset/empty (the default) = OFF: every function below returns null
 * without any network call and callers run their historical Firestore
 * code byte-identically.
 *
 * Fallback contract: a null return ALWAYS means "seam unavailable —
 * run the Firestore path". That covers flag off, no signed-in user and
 * no session cookie, route errors, non-2xx responses, and malformed
 * payloads. Callers must treat a seam result (including exists:false)
 * as authoritative only when it is non-null.
 *
 * Shapes: the route returns Firestore-shaped docs
 * `{ id, exists, data }` where `data` is the stored document body.
 * Timestamp fields (createdAt / updatedAt / handledAt / expiresAt)
 * arrive as ISO strings (Supabase jsonb) or serialized Admin
 * Timestamps; `normalizeSeamData` rewrites them into Timestamp-like
 * shims exposing `toDate()`, so consumers written against Firestore
 * snapshots behave identically on either backend.
 */

export const ROLES_SUPA_SURFACE = 'roles';

const SEAM_ROUTE = '/api/roles/reads';

/** Collections this seam is allowed to touch — mirrors the route whitelist. */
export const ROLES_SEAM_COLLECTIONS = [
  'roles',
  'roleDefinitions',
  'role_permissions',
  'role_requests',
  'permissions',
] as const;
export type RolesSeamCollection = (typeof ROLES_SEAM_COLLECTIONS)[number];

const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'handledAt', 'expiresAt'] as const;

export function parseSupaClientSurfaces(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether the roles surface is switched to the server route. Reads the
 * env at call time (tests and runtime config can flip it); `raw`
 * overrides for tests.
 */
export function rolesSupaEnabled(raw?: string): boolean {
  const value =
    raw ??
    (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_SUPA_SURFACES : undefined);
  const surfaces = parseSupaClientSurfaces(value);
  if (surfaces.size === 0) return false;
  if (surfaces.has('*')) return true;
  return surfaces.has(ROLES_SUPA_SURFACE);
}

/**
 * Client twin of the server flag law (src/lib/supa/flags.ts
 * `isSupaPrimary('roles')`): true iff `roles` is in BOTH the client
 * surfaces twin (NEXT_PUBLIC_SUPA_SURFACES) and the client primary
 * twin (NEXT_PUBLIC_SUPA_PRIMARY), parsed with the identical
 * comma/trim/lowercase/`*` rules. The server twin
 * (SUPA_SURFACES + SUPA_PRIMARY) stays authoritative at the route:
 * the route re-checks `isSupaPrimary('roles')` itself for every
 * non-mirror write, so a stale client twin can only pick the
 * dual-write shape early, never force a primary write the server
 * has not also enabled. Deploy note: NEXT_PUBLIC_SUPA_PRIMARY must
 * be baked alongside SUPA_PRIMARY (the same client-twin build step
 * that bakes NEXT_PUBLIC_SUPA_SURFACES), or client callers will run
 * the dual-write shape while the route runs primary — both stores
 * still get written, but the Firestore leg the flag law retires
 * stays alive until the twin is baked.
 *
 * GRANDFATHERING (identity cutover step 1, design §2.2): the three
 * flows that reach Supabase through this seam — the roleDefinitions
 * upsert (R-21), the /api/roles/reads writeDoc path (R-22) and the
 * role_requests lifecycle (R-23..R-25) — were the program's first
 * primary writes: under SUPA_SURFACES alone they already wrote
 * Supabase-ONLY, while their sibling definition writes (R-16..R-20)
 * dual-wrote. This helper is the re-key: from this step on, a
 * surfaces-only deployment is uniform dual-write everywhere, and
 * adapter-only writes happen only under the primacy gate.
 */
export function rolesSupaPrimary(rawSurfaces?: string, rawPrimary?: string): boolean {
  if (!rolesSupaEnabled(rawSurfaces)) return false;
  const value =
    rawPrimary ??
    (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_SUPA_PRIMARY : undefined);
  const tokens = parseSupaClientSurfaces(value);
  if (tokens.size === 0) return false;
  if (tokens.has('*')) return true;
  return tokens.has(ROLES_SUPA_SURFACE);
}

export interface SeamDoc {
  id: string;
  exists: boolean;
  data: Record<string, unknown> | null;
}

export interface SeamTimestampShim {
  toDate: () => Date;
  seconds: number;
  nanoseconds: number;
}

function toTimestampShim(value: unknown): SeamTimestampShim | null {
  let date: Date | null = null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) date = new Date(t);
  } else if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const seconds =
      typeof rec.seconds === 'number'
        ? rec.seconds
        : typeof rec._seconds === 'number'
          ? rec._seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof rec.nanoseconds === 'number'
          ? rec.nanoseconds
          : typeof rec._nanoseconds === 'number'
            ? rec._nanoseconds
            : 0;
      date = new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
    }
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  const ms = date.getTime();
  return {
    toDate: () => new Date(ms),
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
  };
}

/** Rewrite known timestamp fields of a seam doc body into Timestamp shims. */
export function normalizeSeamData(
  data: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!data) return data;
  const out: Record<string, unknown> = { ...data };
  for (const field of TIMESTAMP_FIELDS) {
    const v = out[field];
    if (v === undefined || v === null) continue;
    if (typeof (v as { toDate?: unknown }).toDate === 'function') continue;
    const shim = toTimestampShim(v);
    if (shim) out[field] = shim;
  }
  return out;
}

async function seamFetch(init: {
  method: 'GET' | 'POST';
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<unknown | null> {
  if (!rolesSupaEnabled()) return null;
  try {
    const headers: Record<string, string> = {};
    // Bearer when a Firebase user is already available; otherwise the
    // __session cookie (set by UserProvider) rides the same-origin
    // fetch and the route's verifyAuthentication accepts it.
    try {
      const { getAuth } = await import('firebase/auth');
      const current = getAuth().currentUser;
      if (current) headers.Authorization = `Bearer ${await current.getIdToken()}`;
    } catch {
      // No auth handle — cookie-only attempt; route decides.
    }
    let url = SEAM_ROUTE;
    if (init.params) {
      const qs = new URLSearchParams(init.params).toString();
      if (qs) url = `${SEAM_ROUTE}?${qs}`;
    }
    const res = await fetch(url, {
      method: init.method,
      headers: init.body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function toSeamDoc(raw: unknown): SeamDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string') return null;
  const exists = rec.exists === true;
  const data =
    exists && rec.data && typeof rec.data === 'object'
      ? normalizeSeamData(rec.data as Record<string, unknown>)
      : null;
  return { id: rec.id, exists, data };
}

/** One-shot doc read. Null = seam unavailable, caller falls back. */
export async function seamGetDoc(
  collection: RolesSeamCollection,
  id: string,
): Promise<SeamDoc | null> {
  const payload = await seamFetch({
    method: 'GET',
    params: { kind: 'doc', collection, id },
  });
  if (!payload || typeof payload !== 'object') return null;
  return toSeamDoc((payload as Record<string, unknown>).doc);
}

/** Full-collection list (small registries only: roleDefinitions scale). */
export async function seamListDocs(
  collection: RolesSeamCollection,
): Promise<SeamDoc[] | null> {
  const payload = await seamFetch({
    method: 'GET',
    params: { kind: 'list', collection },
  });
  return toSeamDocArray(payload);
}

/** Equality-query list with optional descending order (createdAt lists). */
export async function seamQueryDocs(
  collection: RolesSeamCollection,
  whereField: string,
  whereValue: string,
  orderByDescField?: string,
): Promise<SeamDoc[] | null> {
  const params: Record<string, string> = {
    kind: 'query',
    collection,
    field: whereField,
    value: whereValue,
  };
  if (orderByDescField) params.orderByDesc = orderByDescField;
  const payload = await seamFetch({ method: 'GET', params });
  return toSeamDocArray(payload);
}

function toSeamDocArray(payload: unknown): SeamDoc[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const docs = (payload as Record<string, unknown>).docs;
  if (!Array.isArray(docs)) return null;
  const out: SeamDoc[] = [];
  for (const raw of docs) {
    const doc = toSeamDoc(raw);
    if (!doc) return null;
    out.push(doc);
  }
  return out;
}

/**
 * Create/upsert via the route. `id: null` asks the route to mint one
 * (the role_requests create path). Returns the doc id, or null when the
 * seam is unavailable and the caller must run its Firestore write.
 * Payload values must be JSON-plain (ISO strings for timestamps).
 */
export async function seamSetDoc(
  collection: RolesSeamCollection,
  id: string | null,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<{ id: string } | null> {
  const payload = await seamFetch({
    method: 'POST',
    body: { op: 'set', collection, id, data, merge: options?.merge === true },
  });
  if (!payload || typeof payload !== 'object') return null;
  const rid = (payload as Record<string, unknown>).id;
  return typeof rid === 'string' && rid !== '' ? { id: rid } : null;
}

/** Partial update via the route. True on success, null = fall back. */
export async function seamUpdateDoc(
  collection: RolesSeamCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean | null> {
  const payload = await seamFetch({
    method: 'POST',
    body: { op: 'update', collection, id, data },
  });
  if (!payload || typeof payload !== 'object') return null;
  return (payload as Record<string, unknown>).ok === true ? true : null;
}

/**
 * Best-effort MIRROR writes (identity cutover step 1). These are the
 * R-16-style Firestore->Supa mirror leg the flag law promises in
 * NON-primary mode: the caller has ALREADY committed its Firestore
 * primary write and calls these only to shadow it into Supabase.
 * The route honours `mirror: true` by writing the adapter ONLY —
 * never Firestore — in every flag state, so a mirror call can never
 * double-write the primary store or overwrite its native timestamp
 * sentinels with the mirror's ISO strings. Boolean result, never a
 * fallback signal: `false` (flag off, route error, adapter down) is
 * swallowed by callers by design — a failed mirror must not fail the
 * Firestore write that already committed.
 */
export async function seamMirrorSetDoc(
  collection: RolesSeamCollection,
  id: string,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<boolean> {
  const payload = await seamFetch({
    method: 'POST',
    body: { op: 'set', collection, id, data, merge: options?.merge === true, mirror: true },
  });
  if (!payload || typeof payload !== 'object') return false;
  return (payload as Record<string, unknown>).ok === true;
}

/** Best-effort mirror of a committed Firestore partial update. */
export async function seamMirrorUpdateDoc(
  collection: RolesSeamCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const payload = await seamFetch({
    method: 'POST',
    body: { op: 'update', collection, id, data, mirror: true },
  });
  if (!payload || typeof payload !== 'object') return false;
  return (payload as Record<string, unknown>).ok === true;
}
