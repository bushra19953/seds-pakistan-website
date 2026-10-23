/**
 * Server-side effective role (spec B.5).
 *
 * Under roleStoreReadMode 'legacy' and 'dual' this returns the
 * users-mirror-derived role, byte-identical to the pre-Phase-1 behavior
 * for every caller. Under 'authoritative' it derives from roles/{uid}
 * with ONE mirror fallback, only when the roles doc is missing entirely.
 * The client twin lives in src/lib/effective-role.ts.
 *
 * Custom roles (Custom Roles Fix Program, contracts K2): a custom role
 * lawfully occupies ONLY the additionalRoles slot; the catalog fields
 * below never carry one. Two additive fields surface definition-backed
 * custom slugs found in the stored doc:
 * - customAdditionalRoles: lawful custom grants, for display/reporting.
 *   A grant expired at read time (contracts s.2.2 read-time
 *   derivation, ruling R11) is NOT held and is not surfaced here; the
 *   sweep only materialises what the derivation already decided.
 * - customPrimary: DIAGNOSTIC ONLY. A custom_ string in the primary
 *   slot is malformed stored data (e.g. a hand-written doc); K2 makes
 *   it an invalid state, not a holdership. Surfacing it here confers
 *   nothing: `role`/`primary` stay null, XP stays 0 (xpForRoles only
 *   ever receives the catalog fields), and no permission path reads
 *   this field - permission resolution is contracts s.4.4, owned by
 *   the perm-resolution item.
 */

import { getDb } from './firebase-admin';
import {
  resolveRoleForUid,
  normalizeToCanonical,
  normalizeRoleSlug,
  effectiveRoleOf,
  type CatalogRoleKey,
} from '../role-catalog';
import { isCustomRoleSlug, customRoleTitle, customGrantStatus } from '../custom-roles';
import { getCustomRoleDefinition } from './custom-role-registry';
import { isFounderUid } from '@/config/founder';
import { getPhase1Flags } from './phase1-flags';

export interface CustomRoleResolution {
  slug: string;
  /** Definition title (contracts s.4.5 order via customRoleTitle). */
  title: string;
  /** Reporting line only - NEVER an authority source (spec s.4). */
  parentRoleKey: CatalogRoleKey;
  /** The DEFINITION's chapter (authoritative for the custom role). */
  chapterId: string;
}

export interface EffectiveRoleResult {
  /** Effective catalog key, or null when nothing resolves. */
  role: CatalogRoleKey | null;
  primary: CatalogRoleKey | null;
  additionalRoles: CatalogRoleKey[];
  chapterId: string | null;
  source: 'roles' | 'mirror-fallback' | 'none';
  /** Diagnostic surfacing of a custom_ slug stored in the primary slot (see header). */
  customPrimary: CustomRoleResolution | null;
  customAdditionalRoles: CustomRoleResolution[];
}

function resolveStored(raw: unknown, uid: string): CatalogRoleKey | null {
  if (typeof raw !== 'string') return null;
  const result = resolveRoleForUid(raw, uid, isFounderUid);
  if (result.kind === 'catalog' || result.kind === 'legacy') return result.key;
  return null;
}

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * Collect the definition-backed custom slugs in a stored doc. The
 * prefix test is pure and runs first: with no custom_ candidate this
 * performs ZERO Firestore reads. A candidate must also not resolve as
 * catalog/legacy (no catalog key and no LEGACY_TO_CATALOG key or value
 * starts with `custom_`, so the prefix test alone is decisive; the
 * resolution check is belt-and-braces). Junk candidates whose
 * definition fails the four-part test vanish (invariant 10).
 */
async function attachCustomRoles(
  db: Db,
  rawPrimary: unknown,
  rawAdditionals: unknown,
  grantDoc: Record<string, unknown> | undefined,
): Promise<{
  customPrimary: CustomRoleResolution | null;
  customAdditionalRoles: CustomRoleResolution[];
}> {
  const candidates: Array<{ slug: string; isPrimary: boolean }> = [];
  const seen = new Set<string>();
  const consider = (raw: unknown, isPrimary: boolean) => {
    if (typeof raw !== 'string') return;
    const slug = normalizeRoleSlug(raw);
    if (!isCustomRoleSlug(slug)) return;
    if (normalizeToCanonical(slug) !== null) return;
    if (seen.has(slug)) return;
    seen.add(slug);
    candidates.push({ slug, isPrimary });
  };
  consider(rawPrimary, true);
  if (Array.isArray(rawAdditionals)) {
    for (const raw of rawAdditionals) consider(raw, false);
  }
  if (candidates.length === 0) {
    return { customPrimary: null, customAdditionalRoles: [] };
  }

  let customPrimary: CustomRoleResolution | null = null;
  const customAdditionalRoles: CustomRoleResolution[] = [];
  const now = new Date();
  for (const candidate of candidates) {
    // Contracts s.2.2 (ruling R11): an additional grant expired at
    // read time is not held and must not surface as held. The grant
    // doc's flat expiresAt/expiresRoleKey fields are the record; the
    // primary slot is diagnosis-only (K2) and is not filtered here.
    if (
      !candidate.isPrimary &&
      customGrantStatus(grantDoc ?? {}, candidate.slug, now) === 'expired'
    ) {
      continue;
    }
    const def = await getCustomRoleDefinition(db, candidate.slug);
    if (!def) continue;
    const resolution: CustomRoleResolution = {
      slug: def.slug,
      title: customRoleTitle(def, def.slug),
      parentRoleKey: def.parentRoleKey,
      chapterId: def.chapterId,
    };
    if (candidate.isPrimary) {
      customPrimary = resolution;
    } else {
      customAdditionalRoles.push(resolution);
    }
  }
  customAdditionalRoles.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { customPrimary, customAdditionalRoles };
}

export async function getEffectiveRole(uid: string): Promise<EffectiveRoleResult> {
  const db = getDb();
  if (!db)
    return {
      role: null,
      primary: null,
      additionalRoles: [],
      chapterId: null,
      source: 'none',
      customPrimary: null,
      customAdditionalRoles: [],
    };
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
    const custom = await attachCustomRoles(db, userData?.role, userData?.additionalRoles, userData);
    return {
      role: primary ? effectiveRoleOf(primary, additional) : null,
      primary,
      additionalRoles: additional,
      chapterId,
      source: primary ? 'mirror-fallback' : 'none',
      ...custom,
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
    const custom = await attachCustomRoles(db, data.role, data.additionalRoles, data);
    return {
      role: primary ? effectiveRoleOf(primary, additional) : null,
      primary,
      additionalRoles: additional,
      chapterId: (data.chapterId as string | null) ?? chapterId,
      source: 'roles',
      ...custom,
    };
  }

  // The one permitted fallback: roles doc missing entirely. The catalog
  // additionalRoles output stays [] exactly as before (plan C6); the
  // mirror additionals are read ONLY for custom extraction.
  const primary = resolveStored(userData?.role, uid);
  const custom = await attachCustomRoles(db, userData?.role, userData?.additionalRoles, userData);
  return {
    role: primary,
    primary,
    additionalRoles: [],
    chapterId,
    source: primary ? 'mirror-fallback' : 'none',
    ...custom,
  };
}
