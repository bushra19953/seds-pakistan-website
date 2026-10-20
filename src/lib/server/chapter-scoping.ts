import { DEFAULT_ROLE_SCOPES } from '@/config/permission-registry';
import { resolveUserScope } from '@/lib/roles';
import { admin, getDb } from '@/lib/server/firebase-admin';

/**
 * UTILITY: Chapter-Aware Query Scoping
 *
 * Automatically applies chapterId filters to Firestore queries based on dynamic role scope.
 * 1. Checks permissions/{roleSlug}._scope (Dynamic)
 * 2. Falls back to DEFAULT_ROLE_SCOPES[role] (Baseline)
 * 3. For tokens missing from the baseline (e.g. legacy tokens like 'admin'),
 *    falls back to the canonical taxonomy in src/lib/roles.ts, where 'admin'
 *    maps to superadmin with national scope. Without this step, a national
 *    admin holding a legacy token was silently chapter-scoped and dashboard
 *    counts only covered docs carrying their chapterId.
 */
export async function applyChapterScope(
    query: admin.firestore.Query,
    user: { role: string; chapterId?: string }
): Promise<admin.firestore.Query> {
    const db = getDb();
    let scope: 'global' | 'chapter' =
        DEFAULT_ROLE_SCOPES[user.role] ??
        (resolveUserScope(user.role) === 'national' ? 'global' : 'chapter');

    // Check for dynamic override in Firestore
    try {
        if (db) {
            const permSnap = await db.collection('permissions').doc(user.role).get();
            if (permSnap.exists && permSnap.data()?._scope) {
                scope = permSnap.data()?._scope;
            }
        }
    } catch (e) {
        console.warn(`[chapter-scoping] Failed to fetch dynamic scope for ${user.role}, using default.`);
    }

    // Global Scope (National): Returns query as-is
    if (scope === 'global') {
        return query;
    }

    // Chapter Scope: Restricted to user's chapter
    if (user.chapterId) {
        return query.where('chapterId', '==', user.chapterId);
    }

    // Security Fallback: Block all data if scope is chapter but no chapterId exists
    return query.where('chapterId', '==', 'RESTRICTED_NO_CHAPTER');
}

/**
 * Synchronous version using provided scope string
 */
export function applyChapterScopeSync(
    query: admin.firestore.Query,
    user: { role: string; chapterId?: string },
    activeScope: 'global' | 'chapter'
): admin.firestore.Query {
    if (activeScope === 'global') return query;
    if (user.chapterId) return query.where('chapterId', '==', user.chapterId);
    return query.where('chapterId', '==', 'RESTRICTED_NO_CHAPTER');
}
