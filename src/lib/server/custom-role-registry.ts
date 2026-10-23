/**
 * Server adapter for custom role definitions (contracts 4.2).
 *
 * The single server read path for custom definitions: role-writes
 * validation, permission resolution, the AI generator and the expiry
 * sweep all read through here - never the role_permissions /
 * permissions mirrors (contracts 4.1). Follows the isCategoryBRole
 * read pattern (src/lib/server/consent-gate.ts): a direct doc read,
 * narrowed by the ONE four-part test in src/lib/custom-roles.ts.
 * A missing or malformed doc reads as null - deny-by-absence.
 */

import { type Firestore } from 'firebase-admin/firestore';
import {
  toCustomRoleDefinition,
  type CustomRoleDefinition,
} from '@/lib/custom-roles';

const ROLE_DEFINITIONS_COLLECTION = 'roleDefinitions';

export async function getCustomRoleDefinition(
  db: Firestore,
  slug: string,
): Promise<CustomRoleDefinition | null> {
  const snap = await db.collection(ROLE_DEFINITIONS_COLLECTION).doc(slug).get();
  if (!snap.exists) return null;
  return toCustomRoleDefinition(
    slug,
    snap.data() as Record<string, unknown> | undefined,
  );
}

/**
 * Full collection read, filtered in memory (governors full-register
 * precedent; no new composite index). Returns definitions regardless
 * of isActive (plan C10, parent-adopted): role-writes needs an
 * inactive definition visible to fail with custom_role_inactive, and
 * the AI registry filters by status itself. Sorted by slug ascending.
 */
export async function listCustomRoleDefinitions(
  db: Firestore,
  chapterId?: string,
): Promise<CustomRoleDefinition[]> {
  const snap = await db.collection(ROLE_DEFINITIONS_COLLECTION).get();
  const defs: CustomRoleDefinition[] = [];
  for (const docSnap of snap.docs) {
    const def = toCustomRoleDefinition(
      docSnap.id,
      docSnap.data() as Record<string, unknown> | undefined,
    );
    if (!def) continue;
    if (chapterId !== undefined && def.chapterId !== chapterId) continue;
    defs.push(def);
  }
  return defs.sort((a, b) => a.slug.localeCompare(b.slug));
}
