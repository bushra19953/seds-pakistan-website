// identity-backend: backend dispatcher for identity reads — Firestore
// (default) vs Supabase, selected by the SUPA_SURFACES env list. NO
// production callers this wave: permissions.ts / auth-middleware.ts are
// untouched, and routes keep calling the existing accessors until a
// later wave re-points them here.
//
// Semantics (IDENTITY_DEPENDENCY_MAP.md §6.3/§6.4):
// - OFF: byte-identical to today — the existing exported Firestore
//   cached accessors in permissions.ts.
// - ON: the Supa loaders (identity-supa.ts) run behind the EXISTING
//   identity-cache.ts, under a DISTINCT module-level scope sentinel, so
//   Supa entries can never alias Firestore entries (production's
//   Firestore scope is the db handle) and busts/partitioning stay exact.
// - ON + Supa throw: fall back to the Firestore path. The fallback call
//   happens OUTSIDE the failed cache call — the cache never caches a
//   throw, and the fallback uses the Firestore scope, so a failed Supa
//   load can neither poison the Supa partition nor be served from it.
import { getDb } from './firebase-admin';
import {
  getIdentityBundle,
  getPermissionDoc,
  type IdentityBundle,
  type PermissionDocEntry,
} from './identity-cache';
import { getIdentityBundleCached } from './permissions';
import {
  loadIdentityBundleFromSupa,
  loadPermissionDocFromSupa,
} from './identity-supa';
import {
  FIRESTORE_DOC_DEADLINE_MS,
  withReadDeadline,
} from './read-deadline';

type PermissionCollection = 'roleDefinitions' | 'permissions';

/**
 * Distinct cache-scope sentinel for the Supa partition. A module-level
 * frozen object: identity is by reference, exactly one per process,
 * and it can never collide with a Firestore handle.
 */
const SUPA_IDENTITY_SCOPE = Object.freeze({ backend: 'supa-identity' });

/** True iff SUPA_SURFACES (comma-list) includes the 'identity' surface. */
export function useSupaIdentity(): boolean {
  const surfaces = (process.env.SUPA_SURFACES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return surfaces.includes('identity');
}

function requireFirestoreDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[identity-backend] Firestore is not available (getDb() returned null)');
  }
  return db;
}

/**
 * Bundle via the selected backend.
 * OFF -> getIdentityBundleCached (permissions.ts, Firestore scope).
 * ON  -> getIdentityBundle + Supa loader under SUPA_IDENTITY_SCOPE;
 *        a Supa throw falls back to the Firestore accessor.
 */
export async function getIdentityBundleViaBackend(
  uid: string,
): Promise<IdentityBundle> {
  if (!useSupaIdentity()) {
    return getIdentityBundleCached(requireFirestoreDb(), uid);
  }
  try {
    return await getIdentityBundle(uid, () => loadIdentityBundleFromSupa(uid), {
      scope: SUPA_IDENTITY_SCOPE,
    });
  } catch {
    // Supa failed (throw is uncached by identity-cache semantics):
    // fall back to Firestore, outside the failed cache call.
    return getIdentityBundleCached(requireFirestoreDb(), uid);
  }
}

// MERGE-TIME CONSOLIDATION TARGET: this ~8-line loader mirrors the
// Firestore permission-doc loader inside permissions.ts cachedDocGet
// (permissions.ts:121-138) because permissions.ts exports no standalone
// cached permission-doc accessor. When the dispatcher gains production
// callers, extract that loader in permissions.ts and import it here
// instead of keeping this mirror.
async function loadPermissionDocFromFirestore(
  collection: PermissionCollection,
  slug: string,
): Promise<PermissionDocEntry> {
  const db = requireFirestoreDb();
  // Fail-fast deadline (perf program, 2026-10-30): same 8s app-level
  // deadline as the permissions.ts loader this mirrors, so a hung
  // Firestore get rejects in seconds instead of riding the GAPIC
  // retry budget; the throw propagates uncached, exactly as a fast
  // Firestore error does today.
  const snap = await withReadDeadline(
    `identity-backend:permission-doc:${collection}`,
    FIRESTORE_DOC_DEADLINE_MS,
    () => db.collection(collection).doc(slug).get(),
  );
  return {
    exists: snap.exists,
    data: snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined,
  };
}

/**
 * Permission doc via the selected backend. Same dispatch/fallback
 * shape as getIdentityBundleViaBackend. OFF runs the seam-local
 * Firestore mirror loader through the existing getPermissionDoc cache
 * under the Firestore handle scope (the same scope permissions.ts
 * uses), so OFF entries and permissions.ts entries are one partition.
 */
export async function getPermissionDocViaBackend(
  collection: PermissionCollection,
  slug: string,
): Promise<PermissionDocEntry> {
  if (!useSupaIdentity()) {
    return getPermissionDoc(
      collection,
      slug,
      () => loadPermissionDocFromFirestore(collection, slug),
      { scope: requireFirestoreDb() },
    );
  }
  try {
    return await getPermissionDoc(
      collection,
      slug,
      () => loadPermissionDocFromSupa(collection, slug),
      { scope: SUPA_IDENTITY_SCOPE },
    );
  } catch {
    return getPermissionDoc(
      collection,
      slug,
      () => loadPermissionDocFromFirestore(collection, slug),
      { scope: requireFirestoreDb() },
    );
  }
}
