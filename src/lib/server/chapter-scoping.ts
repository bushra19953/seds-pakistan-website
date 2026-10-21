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
export type EffectiveScope = 'global' | 'chapter';

export const RESTRICTED_NO_CHAPTER = 'RESTRICTED_NO_CHAPTER';

/**
 * Resolve a role's effective scope (Item 5, spec 5(b) Modify 1).
 * Extracted from applyChapterScope with identical resolution order:
 * (1) DEFAULT_ROLE_SCOPES, (2) canonical taxonomy fallback
 * (resolveUserScope national -> global), (3) the dynamic
 * permissions/{role}._scope override, applied last. The override is
 * reused exactly as-is in Phase 0; gating or removing it is Phase 1
 * (section 02 P8).
 */
export async function resolveEffectiveScope(role: string): Promise<EffectiveScope> {
    const db = getDb();
    let scope: EffectiveScope =
        DEFAULT_ROLE_SCOPES[role] ??
        (resolveUserScope(role) === 'national' ? 'global' : 'chapter');

    // Check for dynamic override in Firestore
    try {
        if (db) {
            const permSnap = await db.collection('permissions').doc(role).get();
            if (permSnap.exists && permSnap.data()?._scope) {
                scope = permSnap.data()?._scope;
            }
        }
    } catch (e) {
        console.warn(`[chapter-scoping] Failed to fetch dynamic scope for ${role}, using default.`);
    }

    return scope;
}

export type ChapterFilterResult =
    | { ok: true; scope: EffectiveScope; effectiveChapterId: string | null }
    | { ok: false; reason: 'foreign-chapter' };

/**
 * The single Phase 0 chapter rule (Item 5, spec 5(b) rules R1-R3),
 * shared by /api/admin/dashboard/init and /api/admin/users:
 * - R1 global caller: a requested chapterId is honoured as an explicit
 *   filter; absent (or the client's 'All' spelling) means no filter.
 * - R2 chapter caller: no request, 'All', or their own chapterId
 *   resolves to their own chapter; a DIFFERENT chapterId is a
 *   foreign-chapter result and the route must 403. The helper never
 *   silently substitutes and never serves the foreign chapter.
 * - R3 chapter caller with no own chapterId: the RESTRICTED_NO_CHAPTER
 *   sentinel, which matches nothing. Never an unscoped query.
 */
export function resolveChapterFilter(opts: {
    scope: EffectiveScope;
    callerChapterId?: string | null;
    requestedChapterId?: string | null;
}): ChapterFilterResult {
    const raw = (opts.requestedChapterId || '').trim();
    const requested = raw && raw !== 'All' ? raw : null;

    if (opts.scope === 'global') {
        return { ok: true, scope: 'global', effectiveChapterId: requested };
    }

    if (!requested || requested === opts.callerChapterId) {
        return {
            ok: true,
            scope: 'chapter',
            effectiveChapterId: opts.callerChapterId || RESTRICTED_NO_CHAPTER,
        };
    }

    return { ok: false, reason: 'foreign-chapter' };
}

/** Apply a resolved filter to a query: where chapterId == id, or unchanged when null. */
export function applyEffectiveChapterFilter(
    query: admin.firestore.Query,
    result: { effectiveChapterId: string | null }
): admin.firestore.Query {
    if (!result.effectiveChapterId) return query;
    return query.where('chapterId', '==', result.effectiveChapterId);
}

export async function applyChapterScope(
    query: admin.firestore.Query,
    user: { role: string; chapterId?: string }
): Promise<admin.firestore.Query> {
    const scope = await resolveEffectiveScope(user.role);

    // Global Scope (National): Returns query as-is
    if (scope === 'global') {
        return query;
    }

    // Chapter Scope: Restricted to user's chapter
    if (user.chapterId) {
        return query.where('chapterId', '==', user.chapterId);
    }

    // Security Fallback: Block all data if scope is chapter but no chapterId exists
    return query.where('chapterId', '==', RESTRICTED_NO_CHAPTER);
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
