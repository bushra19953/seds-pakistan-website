/**
 * Chapter scoping - compatibility shim (Phase 1, spec C.2).
 *
 * The implementation moved to the single scope resolver:
 * src/lib/scope.ts (pure) + src/lib/server/scope.ts (server wrapper).
 * The two legacy entry points keep their signatures and now delegate to
 * resolveScope, so all 30+ existing callers get resolver semantics
 * (founder-global, fail-closed sentinel, no _scope override) without a
 * flag day. The permissions/{slug}._scope dynamic override is retired:
 * mutable Firestore documents no longer widen authority.
 */

import { admin, getDb } from '@/lib/server/firebase-admin';
import { DEFAULT_ROLE_SCOPES } from '@/config/permission-registry';
import { resolveUserScope } from '@/lib/roles';
import {
  resolveScope,
  scopeAllowsAnyChapter,
  canAccessChapter,
  RESTRICTED_NO_CHAPTER,
  type ScopeResult,
} from '@/lib/scope';

export {
  resolveCallerScope,
  applyScopeToQuery,
  legacyChapterScope,
} from './scope';
export {
  resolveScope,
  canAccessChapter,
  scopeAllowsAnyChapter,
  RESTRICTED_NO_CHAPTER,
};
export type { ScopeResult, ScopeLevel, CallerContext } from '@/lib/scope';

/**
 * Legacy async entry point. Two modes, chosen by whether the caller
 * supplies a uid:
 * - With a uid: the strict resolver applies (founder by UID, rank-driven,
 *   unresolved tokens restricted).
 * - Without a uid (the 30+ existing callers): the legacy token
 *   computation is preserved exactly (DEFAULT_ROLE_SCOPES, then the
 *   canonical resolveUserScope fallback - the Oct 20 fix that maps the
 *   legacy 'admin' token to national scope), because those callers'
 *   behavior is pinned by the chapter-scoping regression suite and by
 *   production routes that have not migrated to resolveCallerScope yet.
 * The one deliberate removal in both modes: the permissions/{slug}._scope
 * Firestore override no longer widens anyone (retired per spec C.2).
 */
export async function applyChapterScope(
  query: admin.firestore.Query,
  user: { uid?: string; role: string; chapterId?: string },
): Promise<admin.firestore.Query> {
  if (user.uid) {
    const scope: ScopeResult = resolveScope({
      uid: user.uid,
      role: user.role,
      chapterId: user.chapterId ?? null,
    });
    if (scopeAllowsAnyChapter(scope)) return query;
    return query.where('chapterId', '==', scope.chapterId ?? RESTRICTED_NO_CHAPTER);
  }
  const legacy: 'global' | 'chapter' =
    DEFAULT_ROLE_SCOPES[user.role] ??
    (resolveUserScope(user.role) === 'national' ? 'global' : 'chapter');
  if (legacy === 'global') return query;
  if (user.chapterId) return query.where('chapterId', '==', user.chapterId);
  return query.where('chapterId', '==', RESTRICTED_NO_CHAPTER);
}

/**
 * Synchronous version using a provided scope string, resolver semantics.
 * 'global' leaves the query untouched; anything else pins the chapter,
 * failing closed on the sentinel when no chapterId exists.
 */
export function applyChapterScopeSync(
  query: admin.firestore.Query,
  user: { role: string; chapterId?: string },
  activeScope: 'global' | 'chapter',
): admin.firestore.Query {
  if (activeScope === 'global') return query;
  if (user.chapterId) return query.where('chapterId', '==', user.chapterId);
  return query.where('chapterId', '==', RESTRICTED_NO_CHAPTER);
}

/**
 * INTEGRATION (step 2 merge, phase0 x phase1): the Phase 0 Item 5 entry
 * points below are preserved verbatim from feat/bylaws-phase0. They are the
 * SERVED behavior for /api/admin/users and /api/admin/dashboard/init during
 * shadow mode (adapter_inventory row 5: serve legacy, log divergence).
 * KNOWN DIVERGENCE, logged not silently resolved: resolveEffectiveScope
 * still honors the permissions/{role}._scope override (Phase 0 semantics),
 * while the resolver path above retires it (Phase 1 spec C.2). Retiring it
 * here is part of the shadow -> enforce flip, which is Zubair-gated.
 * RESTRICTED_NO_CHAPTER is the same sentinel string, re-exported above
 * from '@/lib/scope'; it is not redefined here.
 */
export type EffectiveScope = 'global' | 'chapter';

/**
 * Resolve a role's effective scope (Phase 0 Item 5, spec 5(b) Modify 1).
 * Resolution order: (1) DEFAULT_ROLE_SCOPES, (2) canonical taxonomy
 * fallback (resolveUserScope national -> global), (3) the dynamic
 * permissions/{role}._scope override, applied last.
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
 *   foreign-chapter result and the route must 403.
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
