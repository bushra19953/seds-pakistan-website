/**
 * Server-side effective role (spec B.5).
 *
 * Under roleStoreReadMode 'legacy' and 'dual' this returns the
 * users-mirror-derived role, byte-identical to the pre-Phase-1 behavior
 * for every caller. Under 'authoritative' it derives from roles/{uid}
 * with ONE mirror fallback, only when the roles doc is missing entirely.
 * The client twin lives in src/lib/effective-role.ts.
 */

import { getDb } from './firebase-admin';
import {
  resolveRoleForUid,
  normalizeToCanonical,
  effectiveRoleOf,
  type CatalogRoleKey,
} from '../role-catalog';
import { isFounderUid } from '@/config/founder';
import { getPhase1Flags } from './phase1-flags';

export interface EffectiveRoleResult {
  /** Effective catalog key, or null when nothing resolves. */
  role: CatalogRoleKey | null;
  primary: CatalogRoleKey | null;
  additionalRoles: CatalogRoleKey[];
  chapterId: string | null;
  source: 'roles' | 'mirror-fallback' | 'none';
}

function resolveStored(raw: unknown, uid: string): CatalogRoleKey | null {
  if (typeof raw !== 'string') return null;
  const result = resolveRoleForUid(raw, uid, isFounderUid);
  if (result.kind === 'catalog' || result.kind === 'legacy') return result.key;
  return null;
}

export async function getEffectiveRole(uid: string): Promise<EffectiveRoleResult> {
  const db = getDb();
  if (!db) return { role: null, primary: null, additionalRoles: [], chapterId: null, source: 'none' };
  const mode = getPhase1Flags().roleStoreReadMode;

  const userSnap = await db.collection('users').doc(uid).get();
  const userData = userSnap.data() as Record<string, unknown> | undefined;
  const chapterId = (userData?.chapterId as string | null) ?? null;

  if (mode !== 'authoritative') {
    const primary = resolveStored(userData?.role, uid);
    const additional = Array.isArray(userData?.additionalRoles)
      ? (userData.additionalRoles as unknown[])
          .map((r) => (typeof r === 'string' ? normalizeToCanonical(r) : null))
          .filter((r): r is CatalogRoleKey => r !== null)
      : [];
    return {
      role: primary ? effectiveRoleOf(primary, additional) : null,
      primary,
      additionalRoles: additional,
      chapterId,
      source: primary ? 'mirror-fallback' : 'none',
    };
  }

  const roleSnap = await db.collection('roles').doc(uid).get();
  if (roleSnap.exists) {
    const data = roleSnap.data() as Record<string, unknown>;
    const primary = resolveStored(data.role, uid);
    const additional = Array.isArray(data.additionalRoles)
      ? (data.additionalRoles as unknown[])
          .map((r) => (typeof r === 'string' ? normalizeToCanonical(r) : null))
          .filter((r): r is CatalogRoleKey => r !== null)
      : [];
    return {
      role: primary ? effectiveRoleOf(primary, additional) : null,
      primary,
      additionalRoles: additional,
      chapterId: (data.chapterId as string | null) ?? chapterId,
      source: 'roles',
    };
  }

  // The one permitted fallback: roles doc missing entirely.
  const primary = resolveStored(userData?.role, uid);
  return {
    role: primary,
    primary,
    additionalRoles: [],
    chapterId,
    source: primary ? 'mirror-fallback' : 'none',
  };
}
