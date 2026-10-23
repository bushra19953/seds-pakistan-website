/**
 * Synchronous custom-role registry cache (consumers item, plan H3b/H5).
 *
 * The pure display helpers in src/lib/roles.ts are synchronous and
 * cannot fetch. This module holds the definitions the client adapter
 * (getCustomRoleDefinitions in src/lib/role-definitions.ts) has already
 * loaded, so those helpers - and any other sync consumer - can resolve
 * a custom slug's title without a Firestore import. Population happens
 * through useCustomRoleDefinitions / <CustomRoleRegistryMount /> in
 * src/components/roles/custom-role-registry.tsx; before population,
 * lookups return null and every surface keeps the contracts 4.5
 * humanised-slug floor for custom slugs, then corrects on re-render.
 *
 * Validity is decided once, by the adapter through
 * toCustomRoleDefinition: only four-part-valid definitions ever enter
 * this cache (SEC-10).
 */

import {
  customRoleTitle,
  type CustomRoleDefinition,
} from './custom-roles';

let bySlug: Map<string, CustomRoleDefinition> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // A listener's render error must never break the cache write.
    }
  });
}

/** Populate (or replace) the cache and notify subscribers. */
export function setCustomRoleDefinitions(
  defs: readonly CustomRoleDefinition[],
): void {
  bySlug = new Map(defs.map((d) => [d.slug, d]));
  emit();
}

/** The validated definition for a slug, or null when not loaded/absent. */
export function getCustomRoleDefinitionSync(
  slug: string | null | undefined,
): CustomRoleDefinition | null {
  if (!slug || !bySlug) return null;
  return bySlug.get(slug) ?? null;
}

/**
 * The definition title for a slug when a validated definition is in
 * the cache; null otherwise (callers then use the humanised floor via
 * customRoleTitle(null, slug)).
 */
export function getCustomRoleTitleSync(
  slug: string | null | undefined,
): string | null {
  if (!slug) return null;
  const def = getCustomRoleDefinitionSync(slug);
  return def ? customRoleTitle(def, slug) : null;
}

/** Subscribe to cache population; returns the unsubscribe function. */
export function subscribeCustomRoleDefinitions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test seam (plan H5): seed the cache synchronously, or clear it with
 * null, so jest can exercise definition-aware rendering without a
 * Firestore round-trip.
 */
export function __setCustomRoleDefinitionsForTests(
  defs: readonly CustomRoleDefinition[] | null,
): void {
  if (defs === null) {
    bySlug = null;
    emit();
    return;
  }
  setCustomRoleDefinitions(defs);
}
