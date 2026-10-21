import { Firestore } from "firebase/firestore";
import {
  ROLE_CATALOG,
  type CatalogRoleKey,
} from "./role-catalog";
import { normalizeRoleSlug } from "./role-catalog";
import { FOUNDER_UID, isFounderUid } from "@/config/founder";

export interface RoleOption {
  key: string;
  label: string;
}

export { normalizeRoleSlug };

/**
 * Unified Role Options (Phase 1, spec A.2).
 *
 * Options come from the catalog ONLY. roleDefinitions docs are no longer
 * consulted for options: a definition whose slug is not a catalog key
 * produces no option (the A.7 closure makes every definition a catalog
 * key). The Founder additionally sees founder_patron; no other account
 * ever sees it in a picker.
 *
 * The Firestore argument is retained for call-site compatibility and is
 * intentionally unused.
 */
export async function getUnifiedRoleOptions(
  _firestore: Firestore,
  uid?: string,
): Promise<RoleOption[]> {
  const hiddenForNonFounder: CatalogRoleKey[] = ['founder_patron'];
  const options: RoleOption[] = ROLE_CATALOG
    .filter((role) => isFounderUid(uid) || !hiddenForNonFounder.includes(role.key))
    .map((role) => ({
      key: role.key,
      label: `${role.title} (${role.key})`,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return options;
}

export { FOUNDER_UID };
