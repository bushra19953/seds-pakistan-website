/**
 * Custom roles - the pure core (Custom Roles Fix Program, contracts 4.2).
 *
 * Zero imports beyond ./role-catalog (the role-catalog.ts zero-import
 * discipline), so client components, server routes, PDF code and tests
 * can all import this module. Everything here is pure: no Firestore, no
 * firebase types, no clock reads (callers pass `now`).
 *
 * A custom role is a NON-constitutional, chapter-scoped role created
 * from the admin UI. Its definition lives in roleDefinitions/{slug}
 * with isCustom === true, a catalog parentRoleKey and a chapterId.
 * Its slug always starts with `custom_`. Custom roles are never added
 * to ROLE_CATALOG, carry no rank/XP/vote, and can never hold the
 * Reserved Powers (contracts 1.5).
 */

import {
  ABOLISHED_KEYS,
  isCatalogRoleKey,
  normalizeRoleSlug,
  normalizeToCanonical,
  type CatalogRoleKey,
} from './role-catalog';

export const CUSTOM_ROLE_PREFIX = 'custom_';

/** Reserved Powers a custom role can NEVER carry (contracts 1.5). */
export const RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES:
  readonly ['canManagePermissions', 'canManageRoles'] =
  ['canManagePermissions', 'canManageRoles'] as const;

/**
 * The shape of record for a custom role definition, after the
 * four-part test in toCustomRoleDefinition has accepted a stored doc
 * (contracts 4.2). `name` is the title of record (K3); `permissions`
 * is the ONE stored permission field (K1) - request bodies call it
 * `permissionKeys`, stored docs never do.
 */
export interface CustomRoleDefinition {
  slug: string;
  name: string;
  description: string;
  parentRoleKey: CatalogRoleKey;
  chapterId: string;
  permissions: string[];
  isActive: boolean;
  defaultTermDays: number | null;
}

/**
 * The ONE slug grammar for the custom namespace (merge ruling,
 * globals/merge-notes.md): the strict regex perm-resolution landed in
 * role-catalog.ts, now homed here - this module is the single
 * definition site and role-catalog.ts re-exports from here. Every
 * consumer calls this BEFORE touching catalog helpers (the unguarded
 * catalog accessors throw on unknown keys - contracts 4.4 standing
 * hazard). Grammar depth beyond identity (anti-squat, R6 stems) lives
 * in validateCustomSlug.
 */
const CUSTOM_ROLE_SLUG_PATTERN = /^custom_[a-z0-9]+(_[a-z0-9]+)*$/;

export function isCustomRoleSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && CUSTOM_ROLE_SLUG_PATTERN.test(slug);
}

/**
 * The CLIENT builds the stored slug with this (contracts 1.1); the
 * server never rebuilds, it validates the received slug.
 */
export function buildCustomRoleSlug(displayName: string): string {
  return CUSTOM_ROLE_PREFIX + normalizeRoleSlug(displayName);
}

/**
 * First tokens a custom remainder may never start with (contracts
 * ADDENDUM R6): `custom_founder_assistant`,
 * `custom_president_assistant` and `custom_superadmin_ops` are
 * invalid even though the whole remainder resolves to nothing known.
 */
const RESERVED_SLUG_STEMS: readonly string[] = [
  'founder',
  'president',
  'superadmin',
];

/**
 * Full slug lawfulness (contracts 1.1 a-d). The reason string is
 * stable per failed clause; create-path maps any failure to
 * CUSTOM_SLUG_INVALID and uses the reason for logs/tests.
 */
export function validateCustomSlug(
  slug: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof slug !== 'string' || !slug.startsWith(CUSTOM_ROLE_PREFIX)) {
    return { ok: false, reason: 'slug does not start with the custom_ prefix' };
  }
  const remainder = slug.slice(CUSTOM_ROLE_PREFIX.length);
  if (remainder === '') {
    return { ok: false, reason: 'slug has no name after the custom_ prefix' };
  }
  if (slug !== normalizeRoleSlug(slug)) {
    return { ok: false, reason: 'slug is not in normalised form' };
  }
  if (normalizeToCanonical(remainder) !== null || ABOLISHED_KEYS.includes(remainder)) {
    return {
      ok: false,
      reason: 'name resolves to an existing catalog, legacy or abolished role',
    };
  }
  // Contracts 1.1d names custom_admin invalid, but the anti-squat
  // above cannot see it: 'admin' is the founder token, deliberately
  // absent from LEGACY_TO_CATALOG and ABOLISHED_KEYS because founder
  // identity resolves by UID (role-catalog.ts founder handling).
  if (remainder === 'admin') {
    return { ok: false, reason: 'name is the founder token' };
  }
  // ADDENDUM R6: a remainder whose FIRST token is a reserved stem is
  // invalid even when the whole remainder resolves to nothing known.
  if (RESERVED_SLUG_STEMS.includes(remainder.split('_')[0])) {
    return {
      ok: false,
      reason: 'name starts with a reserved stem (founder, president or superadmin)',
    };
  }
  return { ok: true };
}

/** The defaultTermDays coercion (contracts 1.4): positive integer or null. */
function coerceDefaultTermDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * THE four-part custom-definition test (spec section 10; contracts
 * 1.1, 4.2). Returns null unless ALL hold:
 *   1. the slug is a custom_ slug (isCustomRoleSlug);
 *   2. data.isCustom === true;
 *   3. data.parentRoleKey is a catalog key;
 *   4. data.chapterId is a non-empty string.
 * Junk docs (pakistan-president, super-admin, ...) fail here by
 * construction and never enter any consumer list.
 */
export function toCustomRoleDefinition(
  slug: string,
  data: Record<string, unknown> | undefined,
): CustomRoleDefinition | null {
  if (!isCustomRoleSlug(slug)) return null;
  if (!data || data.isCustom !== true) return null;
  if (!isCatalogRoleKey(data.parentRoleKey)) return null;
  if (typeof data.chapterId !== 'string' || data.chapterId === '') return null;

  // K3: `name` is the title of record; `label` is a legacy mirror,
  // read only as a fallback. There is NO `title` field - never read one.
  const name =
    typeof data.name === 'string' && data.name !== ''
      ? data.name
      : typeof data.label === 'string' && data.label !== ''
        ? data.label
        : '';
  const description =
    typeof data.description === 'string'
      ? data.description
      : typeof data.responsibilities === 'string'
        ? data.responsibilities
        : '';
  const permissions = Array.isArray(data.permissions)
    ? data.permissions.filter((p): p is string => typeof p === 'string')
    : [];

  return {
    slug,
    name,
    description,
    parentRoleKey: data.parentRoleKey,
    chapterId: data.chapterId,
    permissions,
    isActive: data.isActive !== false,
    defaultTermDays: coerceDefaultTermDays(data.defaultTermDays),
  };
}

/**
 * Title for a custom slug (contracts 4.5 steps 3 and 5 - this helper
 * does not do catalog titles): the definition's `name` when a
 * definition is at hand and non-empty, else the humanised slug.
 * NEVER returns the raw slug, never 'Guest', never 'Basic Member'.
 */
export function customRoleTitle(
  def: Pick<CustomRoleDefinition, 'name'> | null,
  slug: string,
): string {
  if (def && typeof def.name === 'string' && def.name.trim() !== '') {
    return def.name;
  }
  const base = slug.startsWith(CUSTOM_ROLE_PREFIX)
    ? slug.slice(CUSTOM_ROLE_PREFIX.length)
    : slug;
  const humanised = base
    .split('_')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  // A slug with nothing humanisable left (e.g. the bare prefix) still
  // must not render as its raw form.
  return humanised !== '' ? humanised : 'Custom Role';
}

/** Normalise a stored expiresAt to epoch millis, structurally (no firebase types). */
function expiresAtMillis(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.toDate === 'function') {
      try {
        const d = (rec.toDate as () => unknown).call(value);
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
      } catch {
        return null;
      }
      return null;
    }
    const seconds =
      typeof rec.seconds === 'number'
        ? rec.seconds
        : typeof rec._seconds === 'number'
          ? rec._seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof rec.nanoseconds === 'number'
          ? rec.nanoseconds
          : typeof rec._nanoseconds === 'number'
            ? rec._nanoseconds
            : 0;
      return seconds * 1000 + Math.floor(nanos / 1_000_000);
    }
  }
  return null;
}

export type CustomGrantStatus = 'none' | 'active' | 'expiring' | 'expired';

/** The 'expiring' window: at or below 30 days (the T-30 alert stage, contracts 5.2). */
const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Read-time derivation of one custom grant's expiry state - the
 * single implementation of the contracts 2.2 derivation (the record
 * of whether a grant IS expired; the sweep only materialises it).
 *
 * 'none' when the doc carries no pending expiry for THIS slug.
 * A present-but-unparseable expiresAt whose expiresRoleKey matches
 * returns 'expired', NOT 'none': treating it as "no pending expiry"
 * would silently keep a grant alive on corrupt data (fail closed).
 */
export function customGrantStatus(
  doc: { expiresAt?: unknown; expiresRoleKey?: string | null },
  slug: string,
  now: Date,
): CustomGrantStatus {
  if (doc.expiresAt === null || doc.expiresAt === undefined) return 'none';
  if (doc.expiresRoleKey !== slug) return 'none';
  const expiresMs = expiresAtMillis(doc.expiresAt);
  if (expiresMs === null) return 'expired';
  const nowMs = now.getTime();
  if (nowMs >= expiresMs) return 'expired';
  if (expiresMs - nowMs <= EXPIRING_WINDOW_MS) return 'expiring';
  return 'active';
}

/**
 * The custom slugs a roles/{uid} doc actually grants its holder right
 * now (client mirror of the server's resolveHolderRoles in
 * lib/server/permissions.ts): string entries of additionalRoles,
 * normalised, custom_ only, never the primary role itself, deduped,
 * with the one pending-expiry grant dropped once customGrantStatus
 * reads 'expired' ('active', 'expiring' and 'none' are all held).
 * Catalog entries in additionalRoles are NOT returned: they confer no
 * permissions at the client layer, exactly as on the server.
 */
export function heldCustomRoleSlugs(
  doc: {
    additionalRoles?: unknown;
    expiresAt?: unknown;
    expiresRoleKey?: string | null;
  },
  primaryRole: string | null | undefined,
  now: Date,
): string[] {
  if (!Array.isArray(doc.additionalRoles)) return [];
  const primary = primaryRole ? normalizeRoleSlug(primaryRole) : null;
  const held: string[] = [];
  for (const entry of doc.additionalRoles) {
    if (typeof entry !== 'string') continue;
    const slug = normalizeRoleSlug(entry);
    if (!isCustomRoleSlug(slug)) continue;
    if (primary !== null && slug === primary) continue;
    if (held.includes(slug)) continue;
    if (customGrantStatus(doc, slug, now) === 'expired') continue;
    held.push(slug);
  }
  return held;
}
