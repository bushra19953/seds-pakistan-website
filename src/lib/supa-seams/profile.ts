/**
 * Supabase seam for the public-profile surface (G4):
 * GET /api/profile/[userId] in src/app/api/profile/[userId]/route.ts.
 *
 * This module is the ONLY place in the profile cluster that knows about
 * the Supabase adapter. It deliberately does NOT import `src/lib/supa/`:
 * that package is not in the base branch this work forks from. The
 * adapter interface below is declared locally, byte-identical in shape
 * to the real one on branch feat/supa-adapter
 * (src/lib/supa/adapter.ts @ 85e657f: SupaAdapter, SupaDoc, DocData,
 * WhereClause, WhereOp, OrderSpec, ListOptions; factories
 * getSupaAdapter()/createSupaAdapter(client) in adapter.ts,
 * getSupaClient() in client.ts, useSupa(surface) in flags.ts).
 * At merge time the local declarations are deleted and `getAdapter()`
 * is re-pointed at `getSupaAdapter()` from `@/lib/supa` -- a pure
 * import swap, no call-site changes.
 *
 * Landing tables (written by the real adapter):
 *   users -> fs_users, roles -> fs_roles
 * Rows: (id text pk, firebase_uid, parent_path, data jsonb, migrated_at);
 * the document body lives in `data`.
 *
 * Migrated reads (users top-level collection + the ONE roles read that
 * is joined for the profile response -- the requester's role doc):
 *   - users/{userId}                       (profile shell)
 *   - roles/{requesterUid}                 (permission gate for the shell)
 *   - users where managerId in <chunk>     (inline MyTeam legacy lookup)
 *   - users/{id} for a chunk of ids        (inline MyTeam detail fetch;
 *     the Firestore form is where(documentId(),'in',chunk) -- the
 *     adapter cannot filter on the id column via a data field, so the
 *     seam performs one getDoc per id, which returns exactly the same
 *     doc set; MyTeam sorts its reports afterwards, so order is moot)
 *
 * Deliberately LEFT on Firestore (see the implementer report):
 *   - users/{userId}/warnings subcollection: the migration kit lands
 *     only two subcollection families (users/{uid}/notifications and
 *     events/{id}/registrations) and create_tables.sql has no
 *     fs_group_warnings table (fs_warnings is a different, top-level
 *     collection). A Supa read would error or return empty.
 *   - PATCH users/{userId} write + its re-read: this group is
 *     reads-only; the re-read must follow the Firestore write, never a
 *     possibly-stale mirror.
 *   - Every non-users collection in the route (projects, tasks,
 *     certificates, chapters, badges, skills,
 *     reporting_relationships): other clusters own them. In particular
 *     the tasks reads are NOT touched at all -- which tasks are
 *     included (assignee-only, both assignment forms, deduped) is
 *     load-bearing for the in-flight tasks-defect fix.
 *
 * Behaviour contract:
 * - Flag OFF (SUPA_SURFACES does not contain 'profile' or '*'), no
 *   adapter (getAdapter() returns null until the merge), or any adapter
 *   error: callers fall back to the exact current Firestore behaviour.
 * - Flag ON: the reads above go through the adapter and are returned
 *   in Firestore-snapshot shape ({ exists, id, data() } / { docs }),
 *   so every downstream line of the route -- privacy gates, section
 *   statuses, cache, response body -- is unchanged.
 *
 * Timestamp conversions: in jsonb, Firestore Timestamps are ISO
 * strings (migration kit). The user fields that are Timestamps in
 * Firestore (USER_TIMESTAMP_FIELDS) are converted at this seam into
 * Timestamp-like objects whose ONLY enumerable own properties are
 * _seconds/_nanoseconds -- exactly what an Admin SDK Timestamp
 * serialises to under JSON.stringify today
 * ({"_seconds":...,"_nanoseconds":...}) -- while also exposing
 * seconds/nanoseconds (non-enumerable getters), toDate(), toMillis()
 * and toISOString() for code consumers. That keeps pass-through fields
 * (termsAcceptedAt and its fallbacks on the profile object) byte-
 * identical, and keeps .seconds/.toDate() consumers working.
 * Fields NOT in the list (and nested values, e.g. eventsAttended[]
 * .attendedAt) stay ISO strings: their consumers already fall back to
 * `new Date(value)` when .seconds is absent (optimized-profile.tsx).
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

export const USERS_COLLECTION = 'users';
export const ROLES_COLLECTION = 'roles';
export const PROFILE_SURFACE = 'profile';

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

/** True only when the flag is ON for 'profile' AND an adapter exists. */
export function isProfileSupaEnabled(): boolean {
  return useSupa(PROFILE_SURFACE) && getAdapter() !== null;
}

/* ------------------------------------------------- timestamp conversions */

export interface TimestampLike {
  readonly _seconds: number;
  readonly _nanoseconds: number;
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate: () => Date;
  toMillis: () => number;
  toISOString: () => string;
}

/**
 * ISO string (jsonb form) -> Timestamp-like that JSON-serialises
 * exactly like an Admin SDK Timestamp: {"_seconds":n,"_nanoseconds":n}.
 * Non-string / unparseable values pass through untouched.
 */
export function toTimestampLike(value: unknown): unknown {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return value;
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = (ms - seconds * 1000) * 1_000_000;
    const out: Record<string, unknown> = {
      _seconds: seconds,
      _nanoseconds: nanoseconds,
      toDate: () => new Date(ms),
      toMillis: () => ms,
      toISOString: () => new Date(ms).toISOString(),
    };
    Object.defineProperties(out, {
      seconds: { get: () => seconds, enumerable: false },
      nanoseconds: { get: () => nanoseconds, enumerable: false },
    });
    return out;
  }
  if (value instanceof Date) return toTimestampLike(value.toISOString());
  return value;
}

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

/** One Firestore-side value -> its jsonb representation (writes are out
 * of scope for this surface; exported for completeness / merge reuse). */
export function serializeValueForSupa(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (isServerTimestampSentinel(value)) return new Date().toISOString();
  if (isTimestampLike(value)) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValueForSupa);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeValueForSupa(inner);
    }
    return out;
  }
  return value;
}

/**
 * Timestamp fields on a users doc (src/types/user.ts + the terms writes
 * in src/components/auth/google-only-auth-form.tsx /
 * src/lib/auth/ensure-user-profile.ts, all serverTimestamp() in
 * Firestore, hence Timestamps on read).
 */
export const USER_TIMESTAMP_FIELDS = [
  'createdAt',
  'lastLogin',
  'updatedAt',
  'termsAcceptedAt',
  'agreedToTermsAt',
  'termsAgreementTimestamp',
  'blacklistedAt',
] as const;

/** Timestamp fields on a roles doc (only `.role` is read by the route;
 * conversion keeps the snapshot shape honest for future consumers). */
export const ROLE_TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'assignedAt'] as const;

export function convertUserTimestamps<T extends DocData>(doc: T): T {
  const out: DocData = { ...doc };
  for (const field of USER_TIMESTAMP_FIELDS) {
    if (typeof out[field] === 'string' || out[field] instanceof Date) {
      out[field] = toTimestampLike(out[field]);
    }
  }
  return out as T;
}

export function convertRoleTimestamps<T extends DocData>(doc: T): T {
  const out: DocData = { ...doc };
  for (const field of ROLE_TIMESTAMP_FIELDS) {
    if (typeof out[field] === 'string' || out[field] instanceof Date) {
      out[field] = toTimestampLike(out[field]);
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
  if (!useSupa(PROFILE_SURFACE) || !adapter) return { status: 'disabled' };
  try {
    return { status: 'ok', value: await run(adapter) };
  } catch (error) {
    return { status: 'error', error };
  }
}

/** Firestore-document-snapshot shape the profile route consumes. */
export interface ProfileDocSnapshot {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

export interface ProfileDocsSnapshot {
  docs: Array<{ id: string; data: () => DocData }>;
}

function toSnapshot(id: string, doc: SupaDoc | null, convert: (d: DocData) => DocData): ProfileDocSnapshot {
  if (!doc) return { exists: false, id, data: () => undefined };
  const { id: _docId, ...rest } = doc;
  void _docId;
  const data = convert(rest);
  return { exists: true, id, data: () => data };
}

function toDocsSnapshot(docs: SupaDoc[], convert: (d: DocData) => DocData): ProfileDocsSnapshot {
  return {
    docs: docs.map((doc) => {
      const { id: _docId, ...rest } = doc;
      void _docId;
      const data = convert(rest);
      return { id: doc.id, data: () => data };
    }),
  };
}

/** users/{userId} -- the profile shell doc. */
export function tryGetProfileUser(userId: string): Promise<SupaReadResult<ProfileDocSnapshot>> {
  return readResult(async (adapter) => {
    const doc = await adapter.getDoc(USERS_COLLECTION, userId);
    return toSnapshot(userId, doc, (d) => convertUserTimestamps(d));
  });
}

/** roles/{requesterUid} -- the ONE roles read joined for the profile
 * response (the requester's permission gate). No other roles read in
 * this file group is migrated. */
export function tryGetProfileRole(requesterUid: string): Promise<SupaReadResult<ProfileDocSnapshot>> {
  return readResult(async (adapter) => {
    const doc = await adapter.getDoc(ROLES_COLLECTION, requesterUid);
    return toSnapshot(requesterUid, doc, (d) => convertRoleTimestamps(d));
  });
}

/** users where managerId in <chunk> -- inline MyTeam legacy lookup. */
export function tryListUsersByManagerIds(managerIds: string[]): Promise<SupaReadResult<ProfileDocsSnapshot>> {
  return readResult(async (adapter) => {
    const docs = await adapter.listDocs(USERS_COLLECTION, {
      where: [['managerId', 'in', managerIds]],
    });
    return toDocsSnapshot(docs, (d) => convertUserTimestamps(d));
  });
}

/** users/{id} for each id in <chunk> -- inline MyTeam detail fetch
 * (Firestore form: where(documentId(),'in',chunk)). Missing docs are
 * simply absent, exactly as with the Firestore 'in' query. */
export function tryGetUsersByIds(ids: string[]): Promise<SupaReadResult<ProfileDocsSnapshot>> {
  return readResult(async (adapter) => {
    const docs: SupaDoc[] = [];
    for (const id of ids) {
      const doc = await adapter.getDoc(USERS_COLLECTION, id);
      if (doc) docs.push(doc);
    }
    return toDocsSnapshot(docs, (d) => convertUserTimestamps(d));
  });
}
