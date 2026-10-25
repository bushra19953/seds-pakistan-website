/**
 * G1 group seam — role + deadline cron sweeps (PLAN_G1 §2).
 *
 * This is the ONLY module in group G1 (reconcile-roles,
 * governors-term-sweep, remind-deadlines, check-deadlines) that imports
 * the shared Supabase db handle. The four routes obtain their `db` here:
 *
 *   const db = getCronG1Db();
 *
 * When the 'cron-g1' surface flag is ON and a Supabase client exists,
 * that is the adapter-backed handle (wrapped, see below); otherwise it
 * is the real Firestore `getDb()` — byte-identical fallback behaviour,
 * including returning null when Firestore is unavailable.
 *
 * The delegated libraries (role-reconciliation, governors/term-sweep,
 * discipline/miss-records, discipline/settings, custom-role-expiry-sweep)
 * are SHARED and are never edited or forked by this group: the routes
 * pass the db obtained here as their `db` argument, and the handle's
 * Firestore-shaped surface (collection/doc/batch, query chaining,
 * FieldValue sentinel resolution) is what they call — see the emulation
 * contract in src/lib/server/supa-db-handle.ts (batch =
 * collect-then-commit, C-G1-3; sentinels resolved at write-apply time,
 * C-G1-4).
 *
 * Timestamp hotspot (PLAN_G1 §3): under the adapter, task
 * `deadline` / `createdAt` values that the migration stored as ISO
 * strings come back as plain strings, and remind-deadlines consumes
 * them via `task.deadline?.toDate()` / `task.createdAt?.toDate()` —
 * without rehydration both passes would silently skip every task.
 * The wrapped handle therefore rehydrates the task timestamp fields
 * (deadline, individualDeadline, createdAt, updatedAt) to
 * Timestamp-like objects (SupaTimestamp, via rehydrateTimestampFields)
 * on every task doc the routes consume, and the task-query helpers
 * below apply the same rehydration to whatever snapshot the underlying
 * db returned, so the behaviour holds for a directly-injected handle
 * in tests as well. Values that are already Timestamp-like, Dates, or
 * non-ISO strings pass through untouched.
 *
 * Hosted sweeps keep the HOST's flag (C-G1-2): check-deadlines passes
 * this same db to the hosted custom-role-expiry sweep (G2's library)
 * and the governor term sweep; no per-sweep flags are invented here.
 *
 * notification-service is NOT routed through this seam: it
 * self-acquires its db via getDb() internally (send() and
 * broadcastByRoles()) and accepts no db argument, so its writes
 * (users/{uid} read, users/{uid}/notifications set + deliveryStatus
 * updates) stay on Firestore even when 'cron-g1' is ON. See
 * BUILDOUT_G1.md for the precise partial-coverage statement.
 */

import { getDb } from '@/lib/server/firebase-admin';
import {
  rehydrateTimestampFields,
  supaDbHandleFor,
  type SupaDbHandle,
} from '@/lib/server/supa-db-handle';

export const CRON_G1_SURFACE = 'cron-g1';

/** Task fields consumed as Timestamps by the G1 routes (PLAN_G1 §3). */
export const TASK_TIMESTAMP_FIELDS: string[] = [
  'deadline',
  'individualDeadline',
  'createdAt',
  'updatedAt',
];

/* ------------------------------------------------------- rehydration */

/** Rehydrate a task doc's timestamp fields from ISO strings. */
export function rehydrateTaskData<T extends Record<string, unknown>>(data: T): T {
  return rehydrateTimestampFields(data, TASK_TIMESTAMP_FIELDS);
}

function wrapTaskDocSnapshot<T extends { data: () => unknown }>(doc: T): T {
  const wrapped = Object.create(Object.getPrototypeOf(doc)) as T;
  Object.assign(wrapped, doc);
  const originalData = doc.data.bind(doc);
  (wrapped as { data: () => unknown }).data = () => {
    const data = originalData();
    if (data === null || data === undefined || typeof data !== 'object') {
      return data;
    }
    return rehydrateTaskData(data as Record<string, unknown>);
  };
  return wrapped;
}

/**
 * Return a query-snapshot-shaped object whose docs' data() rehydrates
 * the task timestamp fields. Doc refs (and every other doc property)
 * are preserved untouched, so `doc.ref.update(...)` in the routes
 * still targets the underlying document.
 */
export function withRehydratedTaskTimes<
  T extends { docs: Array<{ data: () => unknown }> },
>(snapshot: T): T {
  const docs = snapshot.docs.map((doc) => wrapTaskDocSnapshot(doc));
  const wrapped = Object.create(Object.getPrototypeOf(snapshot)) as T;
  Object.assign(wrapped, snapshot);
  (wrapped as { docs: unknown }).docs = docs;
  (wrapped as { forEach: unknown }).forEach = (
    callback: (doc: unknown) => void,
  ) => {
    docs.forEach(callback);
  };
  return wrapped;
}

/* --------------------------------------------------- handle wrapping */

function wrapTasksDocRef(ref: any): any {
  return {
    id: ref.id,
    path: ref.path,
    get: async () => wrapTaskDocSnapshot(await ref.get()),
    set: (...args: unknown[]) => ref.set(...args),
    update: (...args: unknown[]) => ref.update(...args),
    delete: (...args: unknown[]) => ref.delete(...args),
    // Subcollections of a task (none in G1) keep the raw surface.
    collection: (name: string) => ref.collection(name),
  };
}

function wrapTasksQuery(query: any): any {
  const wrapped: any = {
    where: (...args: unknown[]) => wrapTasksQuery(query.where(...args)),
    orderBy: (...args: unknown[]) => wrapTasksQuery(query.orderBy(...args)),
    limit: (...args: unknown[]) => wrapTasksQuery(query.limit(...args)),
    startAfter: (...args: unknown[]) => wrapTasksQuery(query.startAfter(...args)),
    get: async () => withRehydratedTaskTimes(await query.get()),
    count: () => query.count(),
    add: (...args: unknown[]) => query.add(...args),
  };
  // CollectionRef extras (doc/path/id) ride along when present.
  if (typeof query.doc === 'function') {
    wrapped.doc = (id?: string) => wrapTasksDocRef(query.doc(id));
  }
  if (query.path !== undefined) wrapped.path = query.path;
  if (query.id !== undefined) wrapped.id = query.id;
  if (query.collectionPath !== undefined) wrapped.collectionPath = query.collectionPath;
  return wrapped;
}

/**
 * Wrap the shared handle for G1: identical to the handle everywhere
 * except the `tasks` collection / `tasks/{id}` docs, whose snapshots
 * rehydrate the task timestamp fields (see the module header).
 */
export function wrapCronG1Handle(handle: SupaDbHandle): any {
  const raw = handle as any;
  return {
    collection: (path: string) =>
      path === 'tasks' ? wrapTasksQuery(raw.collection(path)) : raw.collection(path),
    doc: (path: string) =>
      path.startsWith('tasks/') ? wrapTasksDocRef(raw.doc(path)) : raw.doc(path),
    batch: () => raw.batch(),
    runTransaction: (updateFunction: unknown) => raw.runTransaction(updateFunction),
  };
}

/* ------------------------------------------------------------ db entry */

/**
 * Resolve the db for a G1 route from an explicit handle-or-null (the
 * test seam): the wrapped handle when one is supplied, else the
 * supplied Firestore db untouched.
 */
export function resolveCronG1Db(
  handle: SupaDbHandle | null,
  firestoreDb: unknown,
): any {
  return handle ? wrapCronG1Handle(handle) : firestoreDb;
}

/** How G1 routes obtain their db: handle when 'cron-g1' is ON, else getDb(). */
export function getCronG1Db(): any {
  return resolveCronG1Db(supaDbHandleFor(CRON_G1_SURFACE), getDb());
}

/* ------------------------------------------------------ task queries */

/** remind-deadlines Pass 1: tasks due inside the 24h window. */
export async function queryDueSoonTasks(
  db: any,
  windowStart: Date,
  windowEnd: Date,
): Promise<any> {
  const snapshot = await db
    .collection('tasks')
    .where('status', 'in', ['pending', 'in-progress'])
    .where('deadline', '>=', windowStart)
    .where('deadline', '<=', windowEnd)
    .get();
  return withRehydratedTaskTimes(snapshot);
}

/** remind-deadlines Pass 2: tasks still awaiting acceptance. */
export async function queryAcceptanceTasks(db: any): Promise<any> {
  const snapshot = await db
    .collection('tasks')
    .where('status', 'in', ['pending', 'in-progress'])
    .where('acceptanceStatus', '==', 'pending-acceptance')
    .get();
  return withRehydratedTaskTimes(snapshot);
}

/** check-deadlines: the status scan (deadline filtering is client-side). */
export async function queryDeadlineScanTasks(db: any): Promise<any> {
  const snapshot = await db
    .collection('tasks')
    .where('status', 'in', ['pending', 'in-progress', 'overdue'])
    .get();
  return withRehydratedTaskTimes(snapshot);
}

/** A single user doc get (check-deadlines' per-assignee read). */
export async function getUserSnapshot(db: any, uid: string): Promise<any> {
  return db.collection('users').doc(uid).get();
}
