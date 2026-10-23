import { Firestore } from "firebase/firestore";
import {
  ROLE_CATALOG,
  type CatalogRoleKey,
} from "./role-catalog";
import { normalizeRoleSlug } from "./role-catalog";
import { getCustomRoleDefinitions } from "./role-definitions";
import { FOUNDER_UID, isFounderUid } from "@/config/founder";

export interface RoleOption {
  key: string;
  label: string;
}

export { normalizeRoleSlug };

/**
 * Unified Role Options (Phase 1, spec A.2; custom roles, contracts 4.2).
 *
 * Catalog options ALWAYS come from the catalog. Custom options (the
 * chapter-scoped definitions from roleDefinitions) are appended ONLY
 * when a chapterId is passed: the helper then reads that chapter's
 * ACTIVE custom definitions through the shared client adapter
 * (getCustomRoleDefinitions) and maps them in the same label format.
 * Callers that pass no chapterId get byte-identical output to the
 * catalog-only construction (plan C5) - in particular the registry
 * duplicate check stays catalog-only on the client; full duplicate
 * enforcement for custom roles is the create route's server check.
 *
 * The Founder additionally sees founder_patron; no other account ever
 * sees it in a picker. The RoleOption shape is unchanged ({ key,
 * label } only): consumers detect a custom option via
 * isCustomRoleSlug(key) from src/lib/custom-roles.ts.
 */
export async function getUnifiedRoleOptions(
  firestore: Firestore,
  uid?: string,
  chapterId?: string,
): Promise<RoleOption[]> {
  const hiddenForNonFounder: CatalogRoleKey[] = ['founder_patron'];
  const options: RoleOption[] = ROLE_CATALOG
    .filter((role) => isFounderUid(uid) || !hiddenForNonFounder.includes(role.key))
    .map((role) => ({
      key: role.key,
      label: `${role.title} (${role.key})`,
    }));

  if (chapterId) {
    const customDefs = await getCustomRoleDefinitions(firestore, { chapterId });
    for (const def of customDefs) {
      options.push({ key: def.slug, label: `${def.name} (${def.slug})` });
    }
  }

  return options.sort((a, b) => a.key.localeCompare(b.key));
}

export { FOUNDER_UID };
