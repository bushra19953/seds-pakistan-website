/**
 * Supabase migration seam for `src/app/api/tasks/delegate/route.ts`
 * (tasks cluster, group 4).
 *
 * The route reaches the Supabase adapter ONLY through this module.
 * The adapter itself lives at `src/lib/supa/` (built in parallel) and is
 * loaded lazily through a variable specifier, so this module compiles
 * and runs identically while the adapter is absent: every helper here
 * returns `null` / `false` ("seam unavailable") and the route falls back
 * to its original Firestore code path, byte-identical.
 *
 * =====================================================================
 * PRE-EXISTING DEFECTS — DO NOT FIX IN THIS SEAM (defect-fix program)
 * =====================================================================
 *
 * FD-01: the delegate route reads the caller id from a non-existent
 * field. The exact line, in BOTH handlers of
 * `src/app/api/tasks/delegate/route.ts`:
 *
 *     const callerUid = (auth.user as any).uid;
 *
 * `verifyAuthentication` (`src/lib/auth-middleware.ts`) returns
 * `auth.user` as an `AuthContext` —
 * `{ user: <decodedToken>, userId, email, displayName, emailVerified,
 * role }` — which has NO top-level `uid`. So `callerUid` is always
 * `undefined`, POST always ends at
 * `403 { error: 'Only the task assignee can delegate' }` for an
 * existing task, and delegation is dead in production.
 *
 * TS-P01: nothing anywhere writes `task.delegation`, so the PATCH
 * handler always returns `400 { error: 'No pending delegation' }` for
 * an existing task; its accept/reject updates are unreachable.
 *
 * This seam deliberately does NOT touch identity: it receives document
 * ids only, never auth state. The future FD-01 fix lands in ONE place —
 * the two `callerUid` lines in the route — and both the Firestore and
 * Supa paths below pick it up unchanged. Enabling the Supa flag must
 * NOT change any observable behavior of this route, including the
 * FD-01 403 and the TS-P01 400; the helpers here only change WHERE a
 * document is read from / written to, never any condition, ordering,
 * or value. See `supa-rebase-notes/tasks-4.md`.
 * =====================================================================
 */

/** Cluster surface string for `useSupa(surface)` — exactly 'tasks'. */
export const TASKS_SURFACE = 'tasks';

/**
 * Locally declared adapter interface (the real module is built in
 * parallel and is not in this branch's base). Firestore-shaped results:
 * documents come back as `{ id, ...data }` from `fs_<collection>`
 * jsonb tables.
 */
export interface SupaAdapter {
  useSupa?: (surface: string) => boolean;
  getDoc: (
    collection: string,
    id: string,
  ) => Promise<Record<string, unknown> | null>;
  listDocs: (
    collection: string,
    options?: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
  countDocs: (
    collection: string,
    options?: Record<string, unknown>,
  ) => Promise<number>;
  setDoc: (
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  updateDoc: (
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  deleteDoc: (collection: string, id: string) => Promise<void>;
}

/** Minimal Firestore-DocumentSnapshot shape the route consumes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SeamDocSnapshot {
  exists: boolean;
  id: string;
  // Matches Firestore's DocumentData ergonomics at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: () => any;
}

let adapterPromise: Promise<SupaAdapter | null> | null = null;

/**
 * Lazily load the Supabase adapter. The specifier is a variable so tsc
 * stays clean while the module is absent. Returns null when the
 * adapter module is unavailable or does not expose the contract.
 */
export function loadSupaAdapter(): Promise<SupaAdapter | null> {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      const candidates: string[] = ['./adapter', './index'];
      for (const specifier of candidates) {
        try {
          const mod = (await import(specifier)) as Record<string, unknown>;
          const adapter = ((mod as { default?: unknown }).default ??
            mod) as SupaAdapter;
          if (adapter && typeof adapter.getDoc === 'function') {
            return adapter;
          }
        } catch {
          // Adapter absent (not yet landed) — try the next candidate.
        }
      }
      return null;
    })();
  }
  return adapterPromise;
}

/** Test/maintenance hook: forget the cached adapter load. */
export function resetSupaAdapterCache(): void {
  adapterPromise = null;
}

async function activeAdapter(): Promise<SupaAdapter | null> {
  try {
    const adapter = await loadSupaAdapter();
    if (!adapter) return null;
    if (typeof adapter.useSupa === 'function') {
      return adapter.useSupa(TASKS_SURFACE) ? adapter : null;
    }
    // Adapter without a useSupa gate: fall back to the env flag
    // convention (default OFF).
    return process.env.NEXT_PUBLIC_USE_SUPA_TASKS === '1' ||
      process.env.USE_SUPA_TASKS === '1'
      ? adapter
      : null;
  } catch {
    return null;
  }
}

function toSnapshot(
  id: string,
  doc: Record<string, unknown> | null,
): SeamDocSnapshot {
  if (!doc) {
    return { exists: false, id, data: () => undefined };
  }
  const { id: _docId, ...data } = doc;
  return { exists: true, id, data: () => data };
}

/**
 * Read `tasks/{taskId}` through the adapter when the 'tasks' flag is
 * ON. Returns null when the seam is unavailable (flag OFF, adapter
 * absent, or adapter error) — the caller then runs its original
 * Firestore read. A resolved snapshot is authoritative, including
 * `exists: false`.
 */
export async function getTaskDocViaSeam(
  taskId: string,
): Promise<SeamDocSnapshot | null> {
  const adapter = await activeAdapter();
  if (!adapter) return null;
  try {
    return toSnapshot(taskId, await adapter.getDoc('tasks', taskId));
  } catch {
    return null;
  }
}

/** Same as {@link getTaskDocViaSeam}, for `users/{uid}`. */
export async function getUserDocViaSeam(
  uid: string,
): Promise<SeamDocSnapshot | null> {
  const adapter = await activeAdapter();
  if (!adapter) return null;
  try {
    return toSnapshot(uid, await adapter.getDoc('users', uid));
  } catch {
    return null;
  }
}

/**
 * Read several `users` docs by id through the adapter (the route's
 * chunked `documentId() in [...]` query equivalent). Returns null when
 * the seam is unavailable so the caller runs its Firestore query.
 */
export async function listUsersByIdsViaSeam(
  ids: string[],
): Promise<Array<{ id: string; data: Record<string, unknown> }> | null> {
  const adapter = await activeAdapter();
  if (!adapter) return null;
  try {
    const out: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const id of ids) {
      const doc = await adapter.getDoc('users', id);
      if (doc) {
        const { id: _docId, ...data } = doc;
        out.push({ id, data });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Apply a field update to `tasks/{taskId}` through the adapter.
 * Returns true when the adapter applied it; false when the seam is
 * unavailable, in which case the caller runs its Firestore update.
 * NOTE: in the current route this is only reachable below the TS-P01
 * "No pending delegation" exit — see the defect note at the top.
 */
export async function updateTaskDocViaSeam(
  taskId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const adapter = await activeAdapter();
  if (!adapter) return false;
  try {
    await adapter.updateDoc('tasks', taskId, fields);
    return true;
  } catch {
    return false;
  }
}
