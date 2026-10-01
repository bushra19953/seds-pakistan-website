import { getDb } from '@/lib/server/firebase-admin';
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
        const roleDefDoc = await db.collection('roleDefinitions').doc(roleSlug).get();
        if (roleDefDoc.exists) {
            const data = roleDefDoc.data();
            if (data && Array.isArray(data.permissions)) {
                if (data.permissions.includes(permission)) return true;
                
                // Also check if the boolean version exists in roleDefinitions (for dual-storage scenarios)
                if (typeof data[permission] === 'boolean') {
                    return data[permission];
                }
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
