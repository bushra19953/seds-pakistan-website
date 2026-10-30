/**
 * Supabase seam for the public-profile surface (G4):
 * GET /api/profile/[userId] in src/app/api/profile/[userId]/route.ts.
 *
 * This module is the ONLY place in the profile cluster that knows about
 * the Supabase adapter. It was written against local declarations
 * byte-identical in shape to the real adapter (src/lib/supa/adapter.ts:
 * SupaAdapter, SupaDoc, DocData, WhereClause, WhereOp, OrderSpec,
 * ListOptions; factories getSupaAdapter()/createSupaAdapter(client) in
 * adapter.ts, getSupaClient() in client.ts, useSupa(surface) in
 * flags.ts). AT MERGE (step 3) the local declarations were deleted and
 * the seam now imports the shipped adapter from `@/lib/supa` -- a pure
 * import swap, no call-site changes, as designed.
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
 *   RBT2 supersedes the bullet above per-section: projects,
 *   certificates, chapters and skills now have helpers at the bottom
 *   of this module, each gated on its OWN surface token; tasks and
 *   reporting_relationships ride the tasks lists seam; badges ride
 *   the gamification seam. The warnings subcollection stays HELD
 *   (no fs_group_warnings table).
 *
 * Behaviour contract:
 * - Flag OFF (SUPA_SURFACES does not contain 'profile' or '*'), an
 *   unconfigured client (adapter calls throw and are caught), or any
 *   adapter error: callers fall back to the exact current Firestore
 *   behaviour.
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

import {
  getSupaAdapter,
  getSupaClient,
  parseSupaSurfaces,
  useSupa,
  type DocData,
  type ListOptions,
  type OrderSpec,
  type SupaAdapter,
  type SupaDoc,
  type WhereClause,
  type WhereOp,
} from '@/lib/supa';

// RE-POINTED AT MERGE (step 3): this seam was written against local
// declarations byte-identical in shape to the adapter on
// feat/supa-adapter. Those declarations are deleted; the seam now
// binds the shipped adapter in src/lib/supa. Every name stays
// exported from this module, so no consumer or test import changes.
export { getSupaClient, parseSupaSurfaces, useSupa };
export type { DocData, ListOptions, OrderSpec, SupaAdapter, SupaDoc, WhereClause, WhereOp };

export const USERS_COLLECTION = 'users';
export const ROLES_COLLECTION = 'roles';
export const PROFILE_SURFACE = 'profile';

/* ------------------------------------------------------------ flag gate */
/* The flag helpers (useSupa / parseSupaSurfaces) and the client
 * factory (getSupaClient) are the shipped ones from src/lib/supa,
 * imported and re-exported at the top of this module. */

/* -------------------------------------------------------- adapter access */

let adapterOverride: SupaAdapter | null | undefined;

/**
 * The adapter for this surface. Re-pointed at merge: delegates to
 * getSupaAdapter() from '@/lib/supa'. That factory returns an adapter
 * even when the client is unconfigured — its calls then throw
 * SupaUnavailableError, which readResult() below converts into the
 * Firestore fallback, so an unconfigured deployment behaves exactly
 * as flag OFF. Tests inject a fake via setAdapterForTests (passing
 * null there forces the disabled path).
 */
export function getAdapter(): SupaAdapter | null {
  if (adapterOverride !== undefined) return adapterOverride;
  return getSupaAdapter();
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

/* ------------------------------------------- RBT2 section reads */
/**
 * Read-bleed fix train 2 (census 19): the profile route's non-users
 * section legs were raw Admin Firestore on every uncached call
 * (~40 reads per core+extended pair on the #2 traffic surface).
 * Each helper below is gated on ITS OWN collection's surface token
 * (useSupa(<collection>)) -- NOT on 'profile' -- so a section flips
 * only when that collection's mirror is itself flipped, exactly like
 * the dedicated seams for those collections elsewhere in the tree.
 * Every helper returns the same { status } contract as the users
 * helpers above: anything other than 'ok' means the caller runs its
 * Firestore leg byte-identically.
 *
 * Deliberately NOT added here:
 * - users/{userId}/warnings: no fs_group_warnings landing table
 *   exists (see the header of this module) -- HELD on Firestore.
 * - tasks / reporting_relationships: the tasks lists seam
 *   (src/lib/supa/seam-tasks-lists.ts, surface 'tasks') already
 *   serves both; the route calls listDocsViaSeam directly.
 * - badges: listBadgeDefinitionsFromSupa (src/lib/supa/gamification.ts,
 *   surface 'gamification') already serves the definitions list; the
 *   route filters it in memory.
 */

async function readResultFor<T>(
  surface: string,
  run: (adapter: SupaAdapter) => Promise<T>,
): Promise<SupaReadResult<T>> {
  const adapter = getAdapter();
  if (!useSupa(surface) || !adapter) return { status: 'disabled' };
  try {
    return { status: 'ok', value: await run(adapter) };
  } catch (error) {
    return { status: 'error', error };
  }
}

const identityData = (d: DocData): DocData => d;

/**
 * projects for one member, replicating the Firestore two-leg shape:
 * teamMemberIds array-contains (limit 5) first; the legacy `team`
 * array-contains leg runs ONLY when the first leg is empty.
 */
export function tryListProjectsForUser(userId: string): Promise<SupaReadResult<ProfileDocsSnapshot>> {
  return readResultFor('projects', async (adapter) => {
    const primary = await adapter.listDocs('projects', {
      where: [['teamMemberIds', 'array-contains', userId]],
      limit: 5,
    });
    if (primary.length > 0) return toDocsSnapshot(primary, identityData);
    const legacy = await adapter.listDocs('projects', {
      where: [['team', 'array-contains', userId]],
      limit: 5,
    });
    return toDocsSnapshot(legacy, identityData);
  });
}

/** certificates where userId == <userId>, bounded at 100 like Firestore. */
export function tryListCertificatesForUser(userId: string): Promise<SupaReadResult<ProfileDocsSnapshot>> {
  return readResultFor('certificates', async (adapter) => {
    const docs = await adapter.listDocs('certificates', {
      where: [['userId', '==', userId]],
      limit: 100,
    });
    return toDocsSnapshot(docs, identityData);
  });
}

/** chapters where isActive == true, bounded at 100 like Firestore. */
export function tryListActiveChapters(): Promise<SupaReadResult<ProfileDocsSnapshot>> {
  return readResultFor('chapters', async (adapter) => {
    const docs = await adapter.listDocs('chapters', {
      where: [['isActive', '==', true]],
      limit: 100,
    });
    return toDocsSnapshot(docs, identityData);
  });
}

/** skills/{id} for each id -- one getDoc per id (the adapter cannot
 * filter on the id column via a data field; same pattern as
 * tryGetUsersByIds). Missing docs are simply absent, exactly as with
 * the Firestore documentId 'in' query, so orphan skill ids still
 * surface through buildSkillEntries. */
export function tryGetSkillsByIds(ids: string[]): Promise<SupaReadResult<ProfileDocsSnapshot>> {
  return readResultFor('skills', async (adapter) => {
    const docs: SupaDoc[] = [];
    for (const id of ids) {
      const doc = await adapter.getDoc('skills', id);
      if (doc) docs.push(doc);
    }
    return toDocsSnapshot(docs, identityData);
  });
}
