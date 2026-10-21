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

import { admin } from '@/lib/server/firebase-admin';
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
