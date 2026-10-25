/**
 * notifications-supa-seam — the ONE seam between the notifications cluster
 * (G2: server paths + routes) and the in-flight Supabase adapter.
 *
 * Every Supabase access from src/lib/notification-helper.ts,
 * src/lib/server/notification-service.ts,
 * src/lib/server/validation-notifications.ts and
 * src/app/api/notifications/route.ts goes through this module, so the
 * merge with the adapter branch re-points everything in ONE edit here:
 *
 *   Real adapter (branch feat/supa-adapter, not on this branch yet):
 *     src/lib/supa/adapter.ts  exports getSupaAdapter(): SupaAdapter
 *       { getDoc, listDocs, countDocs, setDoc, updateDoc, deleteDoc }
 *       over collection paths ('users/{uid}/notifications', 'notifications')
 *     src/lib/supa/flags.ts    exports useSupa(surface)
 *     src/lib/supa/client.ts   exports getSupaClient() (null when
 *       SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unconfigured)
 *
 * Until that branch lands, adapter resolution is a lazy require inside a
 * try/catch: a missing module, an unconfigured client, or any adapter
 * error all resolve to "no adapter", and every caller falls back to
 * Firestore behavior EXACTLY as today. Nothing in this module ever throws
 * into a caller: the notification helpers it serves are explicitly
 * non-throwing, and mirror failures must never fail the original
 * Firestore operation (Firestore stays primary in this wave).
 *
 * Row mapping ( ~/workspace/supabase-migration/migrate_db.js rowFor() ):
 * a document at users/{uid}/notifications/{id} becomes a row
 *   { id, firebase_uid: uid, parent_path: 'users/{uid}/notifications',
 *     data: <document body> }
 * and a top-level notifications/{id} document becomes
 *   { id, firebase_uid: null, parent_path: 'notifications', data }.
 * The adapter's setDoc/updateDoc/deleteDoc(collectionPath, ...) builds
 * exactly that row from the collection path, so this seam passes
 * collection paths and never table names. (The adapter resolves a
 * 3-segment subcollection path to its collectionGroup landing table;
 * the seam is table-agnostic either way.)
 *
 * Data serialization: `data` is jsonb, so Firestore Timestamp / Date /
 * serverTimestamp sentinel values are converted to ISO strings before a
 * body crosses to the adapter (deep, plain objects and arrays recursed).
 * That is also the wire shape GET /api/notifications returns.
 */

/* ------------------------------------------------------------------ types */

export interface NotificationsSupaAdapter {
  setDoc(
    collectionPath: string,
    id: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): Promise<unknown>;
  updateDoc(
    collectionPath: string,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<unknown>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
  listDocs(
    collectionPath: string,
    options?: {
      where?: Array<[string, string, unknown]>;
      orderBy?: string | { field: string; direction?: 'asc' | 'desc' } | Array<{ field: string; direction?: 'asc' | 'desc' }>;
      limit?: number;
      startAfter?: string | number;
    },
  ): Promise<Array<{ id: string } & Record<string, unknown>>>;
  getDoc?: (
    collectionPath: string,
    id: string,
  ) => Promise<({ id: string } & Record<string, unknown>) | null>;
  countDocs?: (
    collectionPath: string,
    where?: Array<[string, string, unknown]>,
  ) => Promise<number>;
}

/* --------------------------------------------------------------- flag gate */

/**
 * useSupa('notifications') equivalent. Mirrors src/lib/supa/flags.ts
 * semantics exactly (SUPA_SURFACES comma list, case-insensitive, '*'
 * enables everything, unset/empty = OFF) so this group does not import a
 * module that does not exist on this branch yet. At adapter merge time
 * this body is the one line that can be swapped for the real useSupa.
 */
export function notificationsSupaEnabled(): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (surfaces.length === 0) return false;
  if (surfaces.includes('*')) return true;
  return surfaces.includes('notifications');
}

/* -------------------------------------------------------- adapter plumbing */

let injectedAdapter: NotificationsSupaAdapter | null | undefined;

/** Test-only injection point (mocked adapter; no live Supabase in tests). */
export function setNotificationsSupaAdapterForTests(
  adapter: NotificationsSupaAdapter | null,
): void {
  injectedAdapter = adapter;
}

function resolveRealAdapter(): NotificationsSupaAdapter | null {
  try {
    // Lazy require so this branch compiles and runs before the adapter
    // branch lands. ONE-EDIT RE-POINT: these two module paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapterModule = require('@/lib/supa/adapter');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientModule = require('@/lib/supa/client');
    if (typeof clientModule?.getSupaClient !== 'function') return null;
    if (!clientModule.getSupaClient()) return null; // unconfigured
    if (typeof adapterModule?.getSupaAdapter !== 'function') return null;
    return adapterModule.getSupaAdapter() as NotificationsSupaAdapter;
  } catch {
    return null;
  }
}

/** The adapter when the surface is ON and Supabase is configured, else null. */
export function getNotificationsSupaAdapter(): NotificationsSupaAdapter | null {
  if (!notificationsSupaEnabled()) return null;
  if (injectedAdapter !== undefined) return injectedAdapter;
  return resolveRealAdapter();
}

/* ------------------------------------------------------------- path helpers */

export function userNotificationsPath(userId: string): string {
  return `users/${userId}/notifications`;
}

export const GLOBAL_NOTIFICATIONS_PATH = 'notifications';

/* ------------------------------------------------------------ serialization */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function timestampLikeToIso(value: Record<string, unknown>): string | null {
  const toDate = (value as { toDate?: unknown }).toDate;
  if (typeof toDate === 'function') {
    try {
      const d = (toDate as () => Date).call(value);
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
    } catch {
      return null;
    }
  }
  const seconds =
    typeof value.seconds === 'number'
      ? value.seconds
      : typeof value._seconds === 'number'
        ? (value._seconds as number)
        : null;
  const nanos =
    typeof value.nanoseconds === 'number'
      ? value.nanoseconds
      : typeof value._nanoseconds === 'number'
        ? (value._nanoseconds as number)
        : 0;
  const keys = Object.keys(value);
  if (seconds !== null && keys.every((k) => ['seconds', 'nanoseconds', '_seconds', '_nanoseconds'].includes(k))) {
    return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
  }
  return null;
}

/**
 * Deep-convert a notification body for jsonb storage / JSON responses:
 * Date and Timestamp-like values become ISO strings; a Firestore
 * FieldValue sentinel (serverTimestamp — a non-plain class instance with
 * no toDate) becomes the current time as an ISO string, matching what
 * Firestore resolves it to at write time, within clock skew.
 */
export function serializeNotificationValue(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) return value.map(serializeNotificationValue);
  if (value !== null && typeof value === 'object') {
    const iso = timestampLikeToIso(value as Record<string, unknown>);
    if (iso !== null) return iso;
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = serializeNotificationValue(v);
      return out;
    }
    // Non-plain object without toDate: a FieldValue sentinel
    // (serverTimestamp). Approximate its resolved value with now.
    return new Date().toISOString();
  }
  return value;
}

export function serializeNotificationData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return serializeNotificationValue(data) as Record<string, unknown>;
}

/* ------------------------------------------------------------ time ordering */

/** Effective timestamp (ms) of a notification doc across both writer
 *  families in this codebase: `createdAt` (helper / service) and
 *  `timestamp` (validation / tasks family). 0 when absent/unparseable. */
export function notificationTimestampMs(doc: Record<string, unknown>): number {
  for (const field of ['createdAt', 'timestamp']) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    const v = serializeNotificationValue(raw);
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (!Number.isNaN(ms)) return ms;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/** Newest-first sort + slice, deduped by id (first occurrence wins). */
export function sortAndLimitNotifications<T extends { id: string } & Record<string, unknown>>(
  docs: T[],
  limit: number,
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const d of docs) {
    if (!d || typeof d.id !== 'string' || seen.has(d.id)) continue;
    seen.add(d.id);
    unique.push(d);
  }
  unique.sort((a, b) => notificationTimestampMs(b) - notificationTimestampMs(a));
  return unique.slice(0, limit);
}

/* -------------------------------------------------------------- mirror ops */
/* All mirror operations are non-throwing by contract. They return true
 * when a Supabase write actually happened, false when the surface is
 * OFF / unconfigured or the mirror failed (Firestore remains primary). */

export async function mirrorNotificationCreate(
  collectionPath: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const adapter = getNotificationsSupaAdapter();
  if (!adapter) return false;
  try {
    await adapter.setDoc(collectionPath, id, serializeNotificationData(data));
    return true;
  } catch (err) {
    console.warn(`[notifications-supa] mirror create failed for ${collectionPath}/${id}:`, err);
    return false;
  }
}

export async function mirrorNotificationUpdate(
  collectionPath: string,
  id: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const adapter = getNotificationsSupaAdapter();
  if (!adapter) return false;
  try {
    await adapter.updateDoc(collectionPath, id, serializeNotificationData(updates));
    return true;
  } catch (err) {
    console.warn(`[notifications-supa] mirror update failed for ${collectionPath}/${id}:`, err);
    return false;
  }
}

export async function mirrorNotificationDelete(
  collectionPath: string,
  id: string,
): Promise<boolean> {
  const adapter = getNotificationsSupaAdapter();
  if (!adapter) return false;
  try {
    await adapter.deleteDoc(collectionPath, id);
    return true;
  } catch (err) {
    console.warn(`[notifications-supa] mirror delete failed for ${collectionPath}/${id}:`, err);
    return false;
  }
}

/* ------------------------------------------------------------------- reads */

/**
 * Read a user's notifications from Supabase, newest-first, limit-capped.
 * Returns null when the surface is OFF / unconfigured OR the adapter
 * errors — callers must then serve Firestore exactly as today.
 *
 * Two ordered queries (createdAt, timestamp) are merged because the
 * codebase's writers split across both field names and a single-field
 * orderBy would silently drop the other family.
 */
export async function listSupaUserNotifications(
  userId: string,
  limit: number,
): Promise<Array<{ id: string } & Record<string, unknown>> | null> {
  const adapter = getNotificationsSupaAdapter();
  if (!adapter) return null;
  const path = userNotificationsPath(userId);
  try {
    const [byCreatedAt, byTimestamp] = await Promise.all([
      adapter.listDocs(path, {
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit,
      }),
      adapter.listDocs(path, {
        orderBy: { field: 'timestamp', direction: 'desc' },
        limit,
      }),
    ]);
    const merged = sortAndLimitNotifications([...byCreatedAt, ...byTimestamp], limit);
    return merged.map((d) => ({
      ...serializeNotificationData(d),
      id: d.id,
    }));
  } catch (err) {
    console.warn(`[notifications-supa] list failed for ${path}, falling back to Firestore:`, err);
    return null;
  }
}
