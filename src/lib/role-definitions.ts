import { collection, doc, getDocs, serverTimestamp, Firestore } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';
import {
  toCustomRoleDefinition,
  type CustomRoleDefinition,
} from './custom-roles';

export type { CustomRoleDefinition };

export type RoleDefinition = {
  role: string;
  description: string;
  // Optional enriched fields for AI context and filtering
  capabilities?: string[];
  level?: number; // override or augment hierarchy
  category?: string;
  aliases?: string[];
  isActive?: boolean;
  displayOrder?: number;
  createdAt?: any;
  updatedAt?: any;
  // Custom Roles Fix Program (contracts 1.2): the stored definition
  // fields, all optional so catalog/legacy rows type-check unchanged.
  // `name` is the title of record (K3); there is deliberately no
  // `title` field - none is ever written.
  slug?: string;
  name?: string;
  label?: string;
  isCustom?: boolean;
  parentRoleKey?: string;
  chapterId?: string;
  /** THE stored permission field (contracts K1). */
  permissions?: string[];
  scope?: string;
  allowedChapters?: string[];
  allowedPaths?: string[];
  canAccessAdmin?: boolean;
  defaultTermDays?: number | null;
};

const ROLE_DEFINITIONS_COLLECTION = 'roleDefinitions';

type CacheEntry = { data: RoleDefinition[]; expiresAt: number } | null;
let cache: CacheEntry = null;

/**
 * Get all role definitions with lightweight in-memory caching.
 * - Defaults to 5 minutes TTL.
 */
export async function getAllRoleDefinitionsCached(
  firestore: Firestore,
  ttlMs: number = 5 * 60 * 1000
): Promise<RoleDefinition[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.data;
  }

  const snap = await getDocs(collection(firestore, ROLE_DEFINITIONS_COLLECTION));
  const list: RoleDefinition[] = snap.docs.map((d) => {
    const data = d.data() as any;
    const role = (data?.slug as string) || d.id; // existing schema uses `slug`
    const description = (data?.description as string) || (data?.responsibilities as string) || '';
    const capabilities = Array.isArray(data?.capabilities) ? data.capabilities.map((c: any) => String(c)) : undefined;
    const level = typeof data?.level === 'number' ? data.level : undefined;
    const category = typeof data?.category === 'string' ? data.category : undefined;
    const aliases = Array.isArray(data?.aliases) ? data.aliases.map((a: any) => String(a)) : undefined;
    const isActive = data?.isActive !== false; // default active
    const displayOrder = typeof data?.displayOrder === 'number' ? data.displayOrder : undefined;
    // Custom Roles fields (contracts 1.2), same defensive coercions as
    // above. The mapper stays dumb: validity is toCustomRoleDefinition's
    // four-part test, applied by the adapter below.
    const slug = role;
    const name = typeof data?.name === 'string' ? data.name : undefined;
    const label = typeof data?.label === 'string' ? data.label : undefined;
    const isCustom = typeof data?.isCustom === 'boolean' ? data.isCustom : undefined;
    const parentRoleKey = typeof data?.parentRoleKey === 'string' ? data.parentRoleKey : undefined;
    const chapterId = typeof data?.chapterId === 'string' ? data.chapterId : undefined;
    const permissions = Array.isArray(data?.permissions)
      ? data.permissions.filter((p: any) => typeof p === 'string')
      : undefined;
    const scope = typeof data?.scope === 'string' ? data.scope : undefined;
    const allowedChapters = Array.isArray(data?.allowedChapters)
      ? data.allowedChapters.map((c: any) => String(c))
      : undefined;
    const allowedPaths = Array.isArray(data?.allowedPaths)
      ? data.allowedPaths.map((p: any) => String(p))
      : undefined;
    const canAccessAdmin = typeof data?.canAccessAdmin === 'boolean' ? data.canAccessAdmin : undefined;
    const defaultTermDays =
      typeof data?.defaultTermDays === 'number' &&
      Number.isInteger(data.defaultTermDays) &&
      data.defaultTermDays > 0
        ? data.defaultTermDays
        : data?.defaultTermDays === null
          ? null
          : undefined;
    return {
      role,
      description,
      capabilities,
      level,
      category,
      aliases,
      isActive,
      displayOrder,
      createdAt: data?.createdAt,
      updatedAt: data?.updatedAt,
      slug,
      name,
      label,
      isCustom,
      parentRoleKey,
      chapterId,
      permissions,
      scope,
      allowedChapters,
      allowedPaths,
      canAccessAdmin,
      defaultTermDays,
    };
  });

  cache = { data: list, expiresAt: now + Math.max(10_000, ttlMs) };
  return list;
}

/** Invalidate the in-memory cache explicitly. */
export function invalidateRoleDefinitionsCache() {
  cache = null;
}

/**
 * Client adapter (contracts 4.2): the valid custom role definitions,
 * mapped through the ONE four-part test in the pure core
 * (toCustomRoleDefinition). Junk and malformed docs never appear.
 * Inactive definitions are excluded unless filter.includeInactive;
 * filter.chapterId keeps only that chapter's definitions. Sorted by
 * slug ascending for deterministic picker lists.
 */
export async function getCustomRoleDefinitions(
  firestore: Firestore,
  filter?: { chapterId?: string; includeInactive?: boolean },
): Promise<CustomRoleDefinition[]> {
  const rows = await getAllRoleDefinitionsCached(firestore);
  const defs: CustomRoleDefinition[] = [];
  for (const row of rows) {
    const def = toCustomRoleDefinition(
      row.role,
      row as unknown as Record<string, unknown>,
    );
    if (!def) continue;
    if (!filter?.includeInactive && def.isActive === false) continue;
    if (filter?.chapterId && def.chapterId !== filter.chapterId) continue;
    defs.push(def);
  }
  defs.sort((a, b) => a.slug.localeCompare(b.slug));
  return defs;
}

/**
 * Upsert a single role definition. Document id aligns to role slug.
 */
export async function upsertRoleDefinition(
  firestore: Firestore,
  role: string,
  description: string
): Promise<void> {
  const slug = String(role).trim();
  if (!slug) return;
  await setDoc(
    doc(firestore, ROLE_DEFINITIONS_COLLECTION, slug),
    {
      slug,
      name: slug,
      description,
      updatedAt: serverTimestamp(),
      // create only on first write; merge keeps existing createdAt if present
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
  invalidateRoleDefinitionsCache();
}
