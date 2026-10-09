import { getDb, admin } from '@/lib/server/firebase-admin';
import { hasPermissionForRole, type PermissionKey } from '@/config/permissions.config';
import { normalizeUserRole, type UserRole } from '@/lib/roles';
import { normalizeRoleSlug } from '@/lib/unified-roles';

// Note: normalizeUserRole() is idempotent for canonical tokens (575d5bb):
// an already-canonical token normalizes to itself, so the
// normalizeRoleSlug-then-normalizeUserRole chain is safe to apply to both
// raw stored tokens and canonical tokens (e.g. a canonical AuthContext.role
// passed back into hasServerPermission, or a canonical token written by the
// new canonical task-form dropdowns).

/**
 * Validates if a user role has the required granular permission by checking 
 * the dynamic Firestore `permissions` collection first, and falling back to the local config.
 */
export async function hasServerPermission(role: UserRole | string | null | undefined, permission: PermissionKey): Promise<boolean> {
    if (!role) return false;

    // Spec step 03: callers may pass a raw stored token or an already
    // canonical token; both converge here. normalizeRoleSlug is idempotent,
    // and normalizeUserRole passes canonical tokens through (575d5bb), so
    // normalizing twice is safe.
    const legacySlug = normalizeRoleSlug(role);
    const canonicalSlug = normalizeUserRole(legacySlug);
    const slugsToTry = canonicalSlug === legacySlug ? [canonicalSlug] : [canonicalSlug, legacySlug];

    if (canonicalSlug === 'superadmin') return true;

    try {
        const db = getDb();
        if (!db) {
            console.warn('[hasServerPermission] No db connection, falling back to static config map');
            return hasPermissionForRole(canonicalSlug as UserRole, permission)
                || hasPermissionForRole(legacySlug as UserRole, permission);
        }

        // First existing Firestore doc wins: the canonical-slug doc is
        // preferred, the legacy-slug doc is honored exactly as before, so
        // existing grants are preserved while the taxonomy migrates.
        const firstExistingDoc = async (collection: string) => {
            for (const slug of slugsToTry) {
                const snap = await db.collection(collection).doc(slug).get();
                if (snap.exists) return snap;
            }
            return null;
        };

        // 1. Check dynamic roleDefinitions (Source of Truth)
        // roleDefinitions stores permissions as an array of keys: { permissions: ['canManageTasks', ...] }
        // The winning doc's array is AUTHORITATIVE: an explicit grant
        // returns true, anything else returns false. No fallthrough past the
        // winning doc, so a stale legacy/static entry can never contradict
        // the configured role.
        const roleDefDoc = await firstExistingDoc('roleDefinitions');
        if (roleDefDoc) {
            const data = roleDefDoc.data();
            if (data && Array.isArray(data.permissions)) {
                if (data.permissions.includes(permission)) return true;
                if (typeof data[permission] === 'boolean') return data[permission];
                return false;
            }
        }

        // 2. Fallback to legacy permissions collection (boolean map)
        const permDoc = await firstExistingDoc('permissions');
        if (permDoc) {
            const data = permDoc.data();
            if (data && typeof data[permission] === 'boolean') {
                return data[permission];
            }
        }
    } catch (error) {
        console.error(`[hasServerPermission] Error fetching permissions for role ${canonicalSlug}:`, error);
    }

    // 3. Fallback to static config mapping if Firestore lookup fails or key is missing.
    // Both slugs are tried so definitions keyed either way keep working.
    return hasPermissionForRole(canonicalSlug as UserRole, permission)
        || hasPermissionForRole(legacySlug as UserRole, permission);
}

/**
 * Canonical role resolution (spec step 03, SEDS-DEV-SPEC-RBAC-2026-V1.0).
 * Single choke point for server-side role checks. Reads roles/{uid}.role
 * first (the declared source of truth, matching the client useUser() hook),
 * falls back to users/{uid}.role (then displayRole) ONLY when the roles doc
 * is missing or empty, then normalizes AT CHECK TIME: normalizeRoleSlug
 * first (legacy slug redirects), normalizeUserRole second (27-token
 * canonical map; already-canonical tokens pass through per 575d5bb).
 * Stored Firestore values are NEVER modified here.
 * Throws on Firestore failure so callers keep their existing error semantics.
 */
export async function resolveCanonicalRole(
  db: admin.firestore.Firestore,
  uid: string
): Promise<string> {
  if (!uid) return 'guest';
  const roleSnap = await db.collection('roles').doc(uid).get();
  let raw: unknown = roleSnap.exists ? roleSnap.data()?.role : null;
  if (typeof raw !== 'string' || !raw.trim()) {
    const userSnap = await db.collection('users').doc(uid).get();
    const data = (userSnap.exists ? userSnap.data() : null) || {};
    const rec = data as Record<string, unknown>;
    raw = rec.role || rec.displayRole || null;
  }
  return normalizeUserRole(normalizeRoleSlug(typeof raw === 'string' ? raw : ''));
}

/**
 * Resolve a user's effective role from their user document.
 * Now delegates to resolveCanonicalRole (spec step 03): roles/{uid}.role is
 * the source of truth, users/{uid}.role is the legacy fallback, and the
 * returned token is canonical-normalized at check time. Stored Firestore
 * values are never rewritten. Returns null when no uid is given or the read
 * fails, preserving this function's historical contract. (Side effect: the
 * known demotion-staleness defect is fixed, because the roles/ doc is now
 * read first instead of the stale users/ copy.)
 */
export async function resolveUserRole(
  db: admin.firestore.Firestore,
  uid: string
): Promise<string | null> {
  if (!uid) return null;
  try {
    return await resolveCanonicalRole(db, uid);
  } catch (e) {
    console.error('[resolveUserRole] failed for', uid, e);
    return null;
  }
}

/**
 * Roles that operate across all chapters. Every other role is chapter-scoped:
 * it may only act on users/resources inside its own chapter.
 */
const GLOBAL_ROLES = new Set([
  'superadmin',
  'admin',
  'president_national',
  'national_vice_president',
  'national_marketing',
]);

export function isChapterScopedRole(role: string | null | undefined): boolean {
  if (!role) return true; // unknown roles default to scoped (least privilege)
  return !GLOBAL_ROLES.has(normalizeRoleSlug(role));
}

/**
 * Enforce chapter scoping: a chapter-scoped actor may only act on targets
 * inside their own chapter. Global roles bypass. When chapter data is
 * missing on either side the check is fail-open (logged) so existing flows
 * without chapterId keep working; an explicit mismatch is always denied.
 */
export async function assertChapterAccess(
  db: admin.firestore.Firestore,
  actorUid: string,
  targetUid: string
): Promise<{ allowed: boolean; reason?: string }> {
  if (!actorUid || !targetUid || actorUid === targetUid) return { allowed: true };
  try {
    const [actorSnap, targetSnap] = await Promise.all([
      db.collection('users').doc(actorUid).get(),
      db.collection('users').doc(targetUid).get(),
    ]);
    const actorRole = actorSnap.exists
      ? (actorSnap.data()?.role || actorSnap.data()?.displayRole || null)
      : null;
    if (!isChapterScopedRole(actorRole)) return { allowed: true }; // global role
    const actorChapter = actorSnap.exists ? actorSnap.data()?.chapterId || null : null;
    const targetChapter = targetSnap.exists ? targetSnap.data()?.chapterId || null : null;
    if (!actorChapter || !targetChapter) return { allowed: true }; // cannot enforce without data
    if (actorChapter !== targetChapter) return { allowed: false, reason: `cross-chapter action denied (${actorChapter} -> ${targetChapter})` };
    return { allowed: true };
  } catch (e) {
    console.error('[assertChapterAccess] failed', e);
    return { allowed: true }; // fail-open on infra error, logged
  }
}
