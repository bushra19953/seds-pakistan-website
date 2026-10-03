import { getDb, admin } from '@/lib/server/firebase-admin';
import { hasPermissionForRole, type PermissionKey } from '@/config/permissions.config';
import type { UserRole } from '@/lib/roles';
import { normalizeRoleSlug } from '@/lib/unified-roles';

/**
 * Validates if a user role has the required granular permission by checking 
 * the dynamic Firestore `permissions` collection first, and falling back to the local config.
 */
export async function hasServerPermission(role: UserRole | string | null | undefined, permission: PermissionKey): Promise<boolean> {
    if (!role) return false;
    
    // Normalize role string for consistent lookups (handles spaces, underscores, case)
    const roleSlug = normalizeRoleSlug(role);
    
    if (roleSlug === 'superadmin') return true;

    try {
        const db = getDb();
        if (!db) {
            console.warn('[hasServerPermission] No db connection, falling back to static config map');
            return hasPermissionForRole(roleSlug as UserRole, permission);
        }

        // 1. Check dynamic roleDefinitions (Source of Truth)
        // roleDefinitions stores permissions as an array of keys: { permissions: ['canManageTasks', ...] }
        // When the doc exists, its array is AUTHORITATIVE: an explicit grant
        // returns true, anything else returns false. No fallthrough, so a
        // stale legacy/static entry can never contradict the configured role.
        const roleDefDoc = await db.collection('roleDefinitions').doc(roleSlug).get();
        if (roleDefDoc.exists) {
            const data = roleDefDoc.data();
            if (data && Array.isArray(data.permissions)) {
                if (data.permissions.includes(permission)) return true;
                if (typeof data[permission] === 'boolean') return data[permission];
                return false;
            }
        }

        // 2. Fallback to legacy permissions collection (boolean map)
        const permDoc = await db.collection('permissions').doc(roleSlug).get();
        if (permDoc.exists) {
            const data = permDoc.data();
            if (data && typeof data[permission] === 'boolean') {
                return data[permission];
            }
        }
    } catch (error) {
        console.error(`[hasServerPermission] Error fetching permissions for role ${roleSlug}:`, error);
    }

    // 3. Fallback to static config mapping if Firestore lookup fails or key is missing
    return hasPermissionForRole(roleSlug as UserRole, permission);
}

/**
 * Resolve a user's effective role from their user document.
 * Reads users/{uid}.role, falling back to displayRole for legacy docs.
 * Returns null when no role is set.
 */
export async function resolveUserRole(
  db: admin.firestore.Firestore,
  uid: string
): Promise<string | null> {
  if (!uid) return null;
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const role = data.role || data.displayRole || null;
    return typeof role === 'string' && role.trim() ? role.trim() : null;
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
    if (actorChapter !== targetChapter) {
      return { allowed: false, reason: `cross-chapter action denied (${actorChapter} -> ${targetChapter})` };
    }
    return { allowed: true };
  } catch (e) {
    console.error('[assertChapterAccess] failed', e);
    return { allowed: true }; // fail-open on infra error, logged
  }
}
