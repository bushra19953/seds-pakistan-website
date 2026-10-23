/**
 * Server adapter for custom role definitions (contracts 4.2) -
 * RESOLUTION-AI branch copy.
 *
 * Implements exactly the contracts s.4.2 API (getCustomRoleDefinition
 * / listCustomRoleDefinitions) so this branch builds and its suites
 * run standalone. The canonical adapter is data-model's deliverable;
 * data-model merges first (merge-plan step 1) and the merge takes
 * data-model's version of this file. Internal differences from
 * data-model's copy are listed in items/resolution-ai/impl-status.md
 * (GAP-1); the exported surface is identical.
 */

import type { admin } from './firebase-admin';
import { normalizeRoleSlug } from '../role-catalog';
import {
  toCustomRoleDefinition,
  type CustomRoleDefinition,
} from '../custom-roles';

export async function getCustomRoleDefinition(
  db: admin.firestore.Firestore,
  slug: string,
): Promise<CustomRoleDefinition | null> {
  const id = normalizeRoleSlug(slug);
  const snap = await db.collection('roleDefinitions').doc(id).get();
  if (!snap.exists) return null;
  return toCustomRoleDefinition(id, snap.data() as Record<string, unknown> | undefined);
}

export async function listCustomRoleDefinitions(
  db: admin.firestore.Firestore,
  chapterId?: string,
): Promise<CustomRoleDefinition[]> {
  const snap = await db.collection('roleDefinitions').get();
  const out: CustomRoleDefinition[] = [];
  snap.forEach((d) => {
    const def = toCustomRoleDefinition(d.id, d.data() as Record<string, unknown> | undefined);
    if (!def) return;
    if (chapterId && def.chapterId !== chapterId) return;
    out.push(def);
  });
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
