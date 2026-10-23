/**
 * Role slug classification (LEGACY-JUNK item, Custom Roles Fix Program).
 *
 * One shared, purely synchronous classifier for every role slug string the
 * platform can meet: catalog keys, legacy tokens, the founder token,
 * custom-role claims, junk ids, and unknown strings. It derives everything
 * from src/lib/role-catalog.ts plus the census junk set below; it is NOT a
 * second table of roles (the catalog stays the only role list - this module
 * classifies strings, including NON-roles).
 *
 * Zero imports beyond ./role-catalog (the role-catalog.ts:1-10 discipline),
 * and NO Firestore access: whether a `custom_` slug is an actual custom
 * role depends on its stored definition (isCustom=true, catalog
 * parentRoleKey, chapterId - the four-part test, contracts.md section 1.2 /
 * section 4.2 toCustomRoleDefinition), which is an async check owned by the
 * create/assign paths. This module judges the STRING only.
 *
 * Precedence is the security property (plan section 2): the exact-id tests
 * run on the RAW input, before any normalising resolver is consulted,
 * because resolveRole() normalises hyphens away and would otherwise launder
 * a junk doc id (e.g. `super-admin`) into a legacy alias (`super_admin`).
 * Junk and unknown FAIL IDENTICALLY on every admission path; they are
 * separate families only so errors, tests, and dispositions can tell
 * "known junk doc" from "never existed".
 */
import {
  ABOLISHED_KEYS,
  isCatalogRoleKey,
  normalizeRoleSlug,
  resolveRole,
} from './role-catalog';
import type { CatalogRoleKey } from './role-catalog';

export type SlugFamily =
  | 'catalog'
  | 'legacy'
  | 'abolished'
  | 'founder_token'
  | 'custom'
  | 'junk'
  | 'unknown';

export interface SlugClassification {
  family: SlugFamily;
  /** normalizeRoleSlug(raw); '' when the input carries no slug characters. */
  normalized: string;
  /** Set only for family 'legacy' (and 'abolished' once the flag flips). */
  legacyTarget?: CatalogRoleKey;
  /**
   * True for the four ABOLISHED_KEYS while ABOLISHED_KEYS_RELEASE is false:
   * they resolve as legacy today and become family 'abolished' (failing
   * like unknown) when the flag flips on Zubair's recorded ruling.
   */
  abolishedPending?: boolean;
  /** Set only for family 'custom': the SEC-09 grammar verdict. */
  customShapeValid?: boolean;
}

export const CUSTOM_SLUG_PREFIX = 'custom_';

export const CUSTOM_SLUG_GRAMMAR = /^custom_[a-z0-9]+(_[a-z0-9]+)*$/;

/**
 * The junk doc ids live in the `permissions` store (Oct 23 census:
 * ~/workspace/seds-phase1/working/phase1-migration/2026-10-23-run2/
 * snapshot.json, taken 2026-10-23T02:08:18Z; plan section 3.4). Each is a
 * hyphenated near-miss spelling of a Block 2 legacy alias for an office a
 * legacy or catalog doc already covers; none has any holder. This set is a
 * classification of record, not a config value: it changes only by a code
 * change that also updates the plan's section 3.4 table. It is deliberately
 * NOT data-driven - a Firestore-read junk list would let the thing being
 * guarded define the guard.
 */
export const JUNK_LIVE_SLUGS: readonly string[] = [
  'advisor-faculty-head',
  'chair-design-media',
  'pakistan-president',
  'super-admin',
];

/**
 * Classify a raw slug string. Applies the plan section 2 tests to the
 * EXACT input, in precedence order; see the module header for why the
 * order (exact-id tests before any normalisation) is the security
 * property.
 */
export function classifyRoleSlug(raw: string | null | undefined): SlugClassification {
  // (1) Non-string / empty / no slug characters -> unknown.
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { family: 'unknown', normalized: '' };
  }
  const normalized = normalizeRoleSlug(raw);
  if (normalized === '') {
    return { family: 'unknown', normalized };
  }

  // (2) CUSTOM SHAPE: the prefix claims the family; grammar validity is
  // reported separately. Family 'custom' is a claim, never legitimacy -
  // the async four-part definition test decides legitimacy elsewhere.
  if (raw.startsWith(CUSTOM_SLUG_PREFIX)) {
    return {
      family: 'custom',
      normalized,
      customShapeValid: CUSTOM_SLUG_GRAMMAR.test(raw),
    };
  }

  // (3) CATALOG: exact key only (a non-canonical spelling falls through
  // to the junk test below, never to here).
  if (isCatalogRoleKey(raw)) {
    return { family: 'catalog', normalized };
  }

  // (4) LEGACY / ABOLISHED: an exact legacy key is its own normalisation.
  // Deriving the verdict from resolveRole means the ABOLISHED_KEYS_RELEASE
  // flip changes the family to 'abolished' with no edit here.
  if (raw === normalized) {
    const resolved = resolveRole(raw);
    if (resolved.kind === 'legacy') {
      return {
        family: 'legacy',
        normalized,
        legacyTarget: resolved.key,
        abolishedPending: ABOLISHED_KEYS.includes(raw),
      };
    }
    if (resolved.kind === 'abolished') {
      return { family: 'abolished', normalized, abolishedPending: false };
    }
  }

  // (5) FOUNDER TOKEN: 'admin' is deliberately not in LEGACY_TO_CATALOG;
  // it resolves only through resolveRoleForUid against the founder UID.
  // Live and load-bearing; NOT junk.
  if (raw === 'admin') {
    return { family: 'founder_token', normalized };
  }

  // (6) JUNK: a known junk doc id, or a non-canonical spelling (hyphens,
  // spaces, uppercase, punctuation - raw !== its normalisation) of a slug
  // that resolves to a catalog or legacy role. The deliberate asymmetry
  // with step (4): `super_admin` (exact Block 2 key) is legacy;
  // `super-admin` is junk.
  if (JUNK_LIVE_SLUGS.includes(raw)) {
    return { family: 'junk', normalized };
  }
  if (raw !== normalized) {
    const resolved = resolveRole(raw);
    if (resolved.kind === 'catalog' || resolved.kind === 'legacy') {
      return { family: 'junk', normalized };
    }
  }

  // (7) UNKNOWN: everything else (invented slugs, near-misses of nothing).
  return { family: 'unknown', normalized };
}

/** Junk, unknown, and (post-flag-flip) abolished slugs fail identically. */
export function failsLikeUnknown(family: SlugFamily): boolean {
  return family === 'junk' || family === 'unknown' || family === 'abolished';
}

/** Convenience wrapper: true only for the junk family. */
export function isJunkSlug(raw: string | null | undefined): boolean {
  return classifyRoleSlug(raw).family === 'junk';
}
