/**
 * Server wrapper for the scope resolver (Phase 1, spec C.2).
 *
 * resolveCallerScope reads the caller's profile through the Admin SDK
 * (the mirror users doc; chapterId falls back to the roles record), runs
 * the pure resolver, and - while scopeResolverMode is 'shadow' - logs one
 * [scope-shadow] divergence line whenever the new scope is NARROWER than
 * what the legacy chapter-scoping computation would have allowed. Shadow
 * mode changes no behavior by itself: callers decide what to enforce.
 */

import { getDb } from './firebase-admin';
import {
  resolveScope,
  scopeAllowsAnyChapter,
  RESTRICTED_NO_CHAPTER,
  type ScopeResult,
} from '../scope';
import { DEFAULT_ROLE_SCOPES } from '@/config/permission-registry';
import { resolveUserScope } from '@/lib/roles';
import { getPhase1Flags } from './phase1-flags';

export {
  RESTRICTED_NO_CHAPTER,
  type ScopeResult,
  type ScopeLevel,
} from '../scope';
export { canAccessChapter, scopeAllowsAnyChapter } from '../scope';

/** Injectable divergence sink (tests capture lines; default is console). */
export type ScopeShadowLogger = (line: string) => void;
let shadowLogger: ScopeShadowLogger = (line) => console.log(line);
export function setScopeShadowLogger(fn: ScopeShadowLogger): void {
  shadowLogger = fn;
}

const LEGACY_RANK: Record<'global' | 'chapter', number> = { global: 2, chapter: 1 };
const NEW_RANK: Record<ScopeResult['level'], number> = {
  global: 4,
  national: 3,
  chapter: 2,
  restricted: 1,
};

/** The pre-Phase-1 chapter-scoping computation (no Firestore override read). */
export function legacyChapterScope(role: string): 'global' | 'chapter' {
  return (
    DEFAULT_ROLE_SCOPES[role] ??
    (resolveUserScope(role) === 'national' ? 'global' : 'chapter')
  );
}

export async function resolveCallerScope(uid: string): Promise<ScopeResult> {
  const db = getDb();
  if (!db) {
    return {
      level: 'restricted',
      chapterId: RESTRICTED_NO_CHAPTER,
      roleKey: null,
      source: 'unresolved-role',
    };
  }
  const [userSnap, roleSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('roles').doc(uid).get(),
  ]);
  const userData = userSnap.data() as Record<string, unknown> | undefined;
  const roleData = roleSnap.data() as Record<string, unknown> | undefined;
  const role =
    (typeof roleData?.role === 'string' ? roleData.role : null) ??
    (typeof userData?.role === 'string' ? userData.role : null);
  const chapterId =
    (typeof roleData?.chapterId === 'string' ? roleData.chapterId : null) ??
    (typeof userData?.chapterId === 'string' ? userData.chapterId : null);

  const scope = resolveScope({ uid, role, chapterId });

  if (getPhase1Flags().scopeResolverMode === 'shadow' && role) {
    const legacy = legacyChapterScope(role);
    const narrows = NEW_RANK[scope.level] < 3 && LEGACY_RANK[legacy] === 2;
    const widens = scopeAllowsAnyChapter(scope) && legacy === 'chapter';
    if (narrows || widens) {
      shadowLogger(
        `[scope-shadow] uid=${uid} role=${role} legacy=${legacy} ` +
          `new=${scope.level} source=${scope.source} roleKey=${scope.roleKey ?? 'none'}`,
      );
    }
  }
  return scope;
}

/**
 * Pin a query to the caller's scope: anywhere-scope returns the query
 * untouched; chapter/restricted pin chapterId == scope.chapterId, where
 * the sentinel matches nothing (fail-closed).
 */
export function applyScopeToQuery<T extends { where(field: string, op: string, value: unknown): T }>(
  query: T,
  scope: ScopeResult,
): T {
  if (scopeAllowsAnyChapter(scope)) return query;
  return query.where('chapterId', '==', scope.chapterId ?? RESTRICTED_NO_CHAPTER);
}
