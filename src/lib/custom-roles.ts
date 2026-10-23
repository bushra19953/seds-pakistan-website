/**
 * Custom roles - pure core (Custom Roles Fix Program, contracts section 4.2).
 *
 * Custom roles are NON-constitutional roles created from the admin UI
 * (brief invariant 1): never in ROLE_CATALOG, no voting, no seats, XP 0.
 * A custom role definition lives in roleDefinitions/{slug} and is valid
 * only when the four-part test in toCustomRoleDefinition holds (spec
 * section 10): slug starts with `custom_`, the doc carries
 * isCustom === true, parentRoleKey is a catalog key, chapterId is a
 * non-empty string. Junk slugs (pakistan-president, super-admin,
 * chair-design-media, advisor-faculty-head) fail by construction.
 *
 * This module imports ONLY ./role-catalog (the role-catalog.ts
 * zero-import discipline) so client components, server routes, PDF code
 * and tests can all import it. Ownership: data-model item (contracts
 * section 7). The consumers worktree carries a contract-faithful copy so
 * its surfaces compile before the merge; the merge planner takes
 * data-model's version if the two ever differ.
 */

import {
  ABOLISHED_KEYS,
  isCatalogRoleKey,
  normalizeRoleSlug,
  normalizeToCanonical,
  type CatalogRoleKey,
} from './role-catalog';

export const CUSTOM_ROLE_PREFIX = 'custom_';

/** Reserved Powers a custom role may NEVER carry (contracts 1.5). */
export const RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES:
  readonly ['canManagePermissions', 'canManageRoles'] =
  ['canManagePermissions', 'canManageRoles'] as const;

export interface CustomRoleDefinition {
  slug: string;
  /** Title of record (contracts K3: the stored `name` field). */
  name: string;
  description: string;
  parentRoleKey: CatalogRoleKey;
  chapterId: string;
  /** THE stored permission field (contracts K1: `permissions`). */
  permissions: string[];
  isActive: boolean;
  defaultTermDays: number | null;
}

/**
 * Cheap partition test every consumer calls before touching catalog
 * helpers (contracts 4.4 standing hazard: the unguarded catalog
 * accessors throw on unknown keys). Prefix + non-empty remainder ONLY;
 * validity is toCustomRoleDefinition's four-part test.
 */
export function isCustomRoleSlug(slug: unknown): slug is string {
  return (
    typeof slug === 'string' &&
    slug.startsWith(CUSTOM_ROLE_PREFIX) &&
    slug.length > CUSTOM_ROLE_PREFIX.length
  );
}

/** The client builds the stored slug with this (contracts 1.1). */
export function buildCustomRoleSlug(displayName: string): string {
  return CUSTOM_ROLE_PREFIX + normalizeRoleSlug(displayName);
}

/**
 * Full slug grammar (contracts 1.1 a-d): prefix, non-empty remainder,
 * already in normalizeRoleSlug form, and an anti-squat rule - the
 * remainder must not itself resolve to a catalog key, a legacy token,
 * or an abolished key.
 */
export function validateCustomSlug(
  slug: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof slug !== 'string' || !slug.startsWith(CUSTOM_ROLE_PREFIX)) {
    return { ok: false, reason: 'slug must start with the custom_ prefix' };
  }
  const remainder = slug.slice(CUSTOM_ROLE_PREFIX.length);
  if (remainder === '') {
    return { ok: false, reason: 'slug has nothing after the custom_ prefix' };
  }
  if (slug !== normalizeRoleSlug(slug)) {
    return { ok: false, reason: 'slug is not in normalizeRoleSlug form' };
  }
  if (normalizeToCanonical(remainder) !== null || ABOLISHED_KEYS.includes(remainder)) {
    return {
      ok: false,
      reason: 'slug remainder shadows a catalog, legacy, or abolished role key',
    };
  }
  return { ok: true };
}

/**
 * The ONE four-part validity test (contracts 1.1, 4.2). Returns null
 * unless ALL hold: isCustomRoleSlug(slug); data.isCustom === true;
 * isCatalogRoleKey(data.parentRoleKey); chapterId is a non-empty
 * string. Field mapping on success follows contracts 1.2: `name` is
 * the title of record, `label` only a read-time mirror fallback;
 * permissions are read from `permissions` ONLY (K1 - `permissionKeys`
 * is a request-body field name and is never read here).
 */
export function toCustomRoleDefinition(
  slug: string,
  data: Record<string, unknown> | undefined,
): CustomRoleDefinition | null {
  if (!isCustomRoleSlug(slug)) return null;
  if (!data || data.isCustom !== true) return null;
  if (!isCatalogRoleKey(data.parentRoleKey)) return null;
  if (typeof data.chapterId !== 'string' || data.chapterId === '') return null;

  const name =
    typeof data.name === 'string' && data.name.trim() !== ''
      ? data.name
      : typeof data.label === 'string' && data.label.trim() !== ''
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
  const defaultTermDays =
    typeof data.defaultTermDays === 'number' &&
    Number.isInteger(data.defaultTermDays) &&
    data.defaultTermDays > 0
      ? data.defaultTermDays
      : null;

  return {
    slug,
    name,
    description,
    parentRoleKey: data.parentRoleKey,
    chapterId: data.chapterId,
    permissions,
    isActive: data.isActive !== false,
    defaultTermDays,
  };
}

/** Humanised slug floor: strip prefix, underscores to spaces, title-case. */
function humaniseCustomSlug(slug: string): string {
  const rest = isCustomRoleSlug(slug) ? slug.slice(CUSTOM_ROLE_PREFIX.length) : slug;
  const words = rest.replace(/_/g, ' ').trim();
  if (words === '') return 'Custom Role';
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Title for a custom slug (contracts 4.5 steps 3 and 5): the
 * definition's `name` when a definition is at hand, else the humanised
 * slug. NEVER returns the raw slug, never 'Guest', never
 * 'Basic Member'.
 */
export function customRoleTitle(
  def: Pick<CustomRoleDefinition, 'name'> | null,
  slug: string,
): string {
  if (def && typeof def.name === 'string' && def.name.trim() !== '') {
    return def.name;
  }
  return humaniseCustomSlug(slug);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Structural expiresAt normalisation - the core imports no Firebase types. */
function expiresAtToMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toDate === 'function') {
      try {
        const d = (v.toDate as () => unknown)();
        const t = d instanceof Date ? d.getTime() : NaN;
        return Number.isNaN(t) ? null : t;
      } catch {
        return null;
      }
    }
    const seconds =
      typeof v.seconds === 'number'
        ? v.seconds
        : typeof v._seconds === 'number'
          ? v._seconds
          : null;
    if (seconds !== null) {
      const nanos =
        typeof v.nanoseconds === 'number'
          ? v.nanoseconds
          : typeof v._nanoseconds === 'number'
            ? v._nanoseconds
            : 0;
      return seconds * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
}

/**
 * Read-time grant status derivation (contracts 2.2 - the mechanism of
 * record; the sweep only materialises). 'none' when this roles doc has
 * no pending expiry for this slug; 'expired' when now >= expiresAt
 * (exclusive instant, governors termEnd semantics); 'expiring' inside
 * the 30-day T-30 window (contracts 5.2); else 'active'.
 *
 * Judgement call (flagged per data-model plan C9): a present but
 * unparseable expiresAt whose expiresRoleKey matches returns 'expired'
 * - failing toward expiry, never silently keeping a grant alive on a
 * corrupt date.
 */
export function customGrantStatus(
  doc: { expiresAt?: unknown; expiresRoleKey?: string | null },
  slug: string,
  now: Date,
): 'none' | 'active' | 'expiring' | 'expired' {
  if (doc.expiresAt === null || doc.expiresAt === undefined) return 'none';
  if (doc.expiresRoleKey !== slug) return 'none';
  const ms = expiresAtToMillis(doc.expiresAt);
  if (ms === null) return 'expired';
  const nowMs = now.getTime();
  if (nowMs >= ms) return 'expired';
  if (ms - nowMs <= THIRTY_DAYS_MS) return 'expiring';
  return 'active';
}
