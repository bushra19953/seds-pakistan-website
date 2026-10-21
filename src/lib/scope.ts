/**
 * The single chapter-scope resolver (Phase 1, spec C.1). PURE module:
 * no Firebase imports, so it runs in client code, server code, and tests.
 *
 * Rules, in order:
 * 1. The Founder (by UID) is global, whatever any store says.
 * 2. An unresolvable role token is restricted - NEVER promoted to a wider
 *    scope by a chapterId fallback (the old "role says X, chapterId says
 *    Y, caller wins" hole). ChapterId never compensates for missing rank.
 * 3. Rank decides: R5/R4 global, R3 national, R2 chapter (chapterId
 *    required; absent means restricted-to-nothing), R1/R0 restricted to
 *    the caller's own chapter (visibility, not authority).
 *
 * This replaces four legacy mechanisms (DEFAULT_ROLE_SCOPES + resolveUserScope
 * fallback, permissions/{slug}._scope, profile chapterId arithmetic, and
 * per-route allow-lists). Legacy tokens resolve through the ONE corrected
 * map in role-catalog.ts.
 */

import {
  resolveRoleForUid,
  rankOf,
  type CatalogRoleKey,
} from './role-catalog';
import { isFounderUid } from '@/config/founder';

export type ScopeLevel = 'global' | 'national' | 'chapter' | 'restricted';

export interface CallerContext {
  uid: string;
  /** Raw stored role token (roles record or mirror), unresolved. */
  role: string | null;
  chapterId: string | null;
}

export interface ScopeResult {
  level: ScopeLevel;
  /** Set for chapter and restricted scopes; null for global/national. */
  chapterId: string | null;
  roleKey: CatalogRoleKey | null;
  source: 'founder' | 'catalog' | 'unresolved-role' | 'missing-chapter';
}

/** Sentinel chapter id matching no real chapter (fail-closed). */
export const RESTRICTED_NO_CHAPTER = 'RESTRICTED_NO_CHAPTER';

export function resolveScope(caller: CallerContext): ScopeResult {
  if (isFounderUid(caller.uid)) {
    return { level: 'global', chapterId: null, roleKey: 'founder_patron', source: 'founder' };
  }
  const resolved = resolveRoleForUid(caller.role, caller.uid, isFounderUid);
  if (resolved.kind !== 'catalog' && resolved.kind !== 'legacy') {
    return {
      level: 'restricted',
      chapterId: caller.chapterId ?? RESTRICTED_NO_CHAPTER,
      roleKey: null,
      source: 'unresolved-role',
    };
  }
  const key = resolved.key;
  const rank = rankOf(key);
  if (rank === 'R5' || rank === 'R4') {
    return { level: 'global', chapterId: null, roleKey: key, source: 'catalog' };
  }
  if (rank === 'R3') {
    return { level: 'national', chapterId: null, roleKey: key, source: 'catalog' };
  }
  if (rank === 'R2') {
    if (caller.chapterId) {
      return { level: 'chapter', chapterId: caller.chapterId, roleKey: key, source: 'catalog' };
    }
    return {
      level: 'restricted',
      chapterId: RESTRICTED_NO_CHAPTER,
      roleKey: key,
      source: 'missing-chapter',
    };
  }
  // R1 / R0: restricted to own chapter for record visibility only.
  return {
    level: 'restricted',
    chapterId: caller.chapterId ?? RESTRICTED_NO_CHAPTER,
    roleKey: key,
    source: 'catalog',
  };
}

/** Whether the scope may touch records of the given chapter. */
export function canAccessChapter(scope: ScopeResult, chapterId: string | null): boolean {
  if (scope.level === 'global' || scope.level === 'national') return true;
  if (!chapterId) return false;
  return scope.chapterId === chapterId;
}

/** True when no chapter pinning applies at all (global or national). */
export function scopeAllowsAnyChapter(scope: ScopeResult): boolean {
  return scope.level === 'global' || scope.level === 'national';
}
