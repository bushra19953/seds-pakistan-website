import { collection, doc, getDocs, serverTimestamp, Firestore } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';
import { toCustomRoleDefinition, type CustomRoleDefinition } from './custom-roles';
import {
  rolesSupaEnabled,
  seamListDocs,
  seamSetDoc,
} from './supa-roles-client-seam';

;

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
  // Custom-role definition fields (contracts 1.2). All optional so every
  // existing row type-checks unchanged. `name` is the title of record
  // (K3); there is deliberately NO `title` field. `permissions` is the
  // ONE stored permission field (K1) - `permissionKeys` is request-only.
  slug?: string;
  name?: string;
  label?: string;
  isCustom?: boolean;
  // Typed string, not CatalogRoleKey: this type must be able to
  // represent a malformed stored doc so toCustomRoleDefinition can
  // reject it; the narrowing lives in CustomRoleDefinition.
  parentRoleKey?: string;
  chapterId?: string;
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

  // Supa seam (file-group 3): behind the flag, the registry list comes
  // from the server route (/api/roles/reads, Supabase adapter or Admin
  // SDK server-side); a null return falls back to the direct Firestore
  // read below, byte-identically. Flag OFF never reaches the seam call.
  if (rolesSupaEnabled()) {
    const seamDocs = await seamListDocs('roleDefinitions');
    if (seamDocs) {
      const list: RoleDefinition[] = seamDocs.map((d) =>
        mapRoleDefinitionDoc(d.id, (d.data ?? {}) as Record<string, unknown>)
      );
      cache = { data: list, expiresAt: now + Math.max(10_000, ttlMs) };
      return list;
    }
  }

  const snap = await getDocs(collection(firestore, ROLE_DEFINITIONS_COLLECTION));
  const list: RoleDefinition[] = snap.docs.map((d) =>
    mapRoleDefinitionDoc(d.id, d.data() as Record<string, unknown>)
  );

  cache = { data: list, expiresAt: now + Math.max(10_000, ttlMs) };
  return list;
}

/**
 * The stored-doc -> RoleDefinition mapping, shared by the Firestore
 * path and the seam path so both return byte-identical shapes.
 */
function mapRoleDefinitionDoc(docId: string, rawData: Record<string, unknown>): RoleDefinition {
  {
    const data = rawData as any;
    const d = { id: docId };
    const role = (data?.slug as string) || d.id; // existing schema uses `slug`
    const description = (data?.description as string) || (data?.responsibilities as string) || '';
    const capabilities = Array.isArray(data?.capabilities) ? data.capabilities.map((c: any) => String(c)) : undefined;
    const level = typeof data?.level === 'number' ? data.level : undefined;
    const category = typeof data?.category === 'string' ? data.category : undefined;
    const aliases = Array.isArray(data?.aliases) ? data.aliases.map((a: any) => String(a)) : undefined;
    const isActive = data?.isActive !== false; // default active
    const displayOrder = typeof data?.displayOrder === 'number' ? data.displayOrder : undefined;
    // Custom-role fields (contracts 1.2), carried with the same
    // defensive coercions as the fields above: junk values become
    // undefined, never a throw. defaultTermDays duplicates the core's
    // 3-line positive-integer rule (contracts 1.4) - the mapper stays
    // dumb; the four-part narrowing lives in toCustomRoleDefinition.
    const slug = typeof data?.slug === 'string' ? data.slug : undefined;
    const name = typeof data?.name === 'string' ? data.name : undefined;
    const label = typeof data?.label === 'string' ? data.label : undefined;
    const isCustom = data?.isCustom === true ? true : undefined;
    const parentRoleKey = typeof data?.parentRoleKey === 'string' ? data.parentRoleKey : undefined;
    const chapterId = typeof data?.chapterId === 'string' ? data.chapterId : undefined;
    const permissions = Array.isArray(data?.permissions)
      ? data.permissions.filter((p: any) => typeof p === 'string')
      : undefined;
    const scope = typeof data?.scope === 'string' ? data.scope : undefined;
    const allowedChapters = Array.isArray(data?.allowedChapters) ? data.allowedChapters.map((c: any) => String(c)) : undefined;
    const allowedPaths = Array.isArray(data?.allowedPaths) ? data.allowedPaths.map((p: any) => String(p)) : undefined;
    const canAccessAdmin = typeof data?.canAccessAdmin === 'boolean' ? data.canAccessAdmin : undefined;
    const defaultTermDays =
      typeof data?.defaultTermDays === 'number' && Number.isInteger(data.defaultTermDays) && data.defaultTermDays > 0
        ? data.defaultTermDays
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
  }
}

/** Invalidate the in-memory cache explicitly. */
export function invalidateRoleDefinitionsCache() {
  cache = null;
}

/**
 * Client adapter for custom role definitions (contracts 4.2), built on
 * the cached reader above. Every row is narrowed through the ONE
 * four-part test (toCustomRoleDefinition): junk, catalog and malformed
 * docs never come back. Inactive definitions are dropped unless
 * includeInactive is set; chapterId filters to one chapter. Sorted by
 * slug ascending for deterministic picker lists.
 */
export async function getCustomRoleDefinitions(
  firestore: Firestore,
  filter?: { chapterId?: string; includeInactive?: boolean },
): Promise<CustomRoleDefinition[]> {
  const rows = await getAllRoleDefinitionsCached(firestore);
  const defs: CustomRoleDefinition[] = [];
  for (const row of rows) {
    const def = toCustomRoleDefinition(row.role, row as unknown as Record<string, unknown>);
    if (!def) continue;
    if (!filter?.includeInactive && def.isActive === false) continue;
    if (filter?.chapterId !== undefined && def.chapterId !== filter.chapterId) continue;
    defs.push(def);
  }
  return defs.sort((a, b) => a.slug.localeCompare(b.slug));
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
  // Supa seam: behind the flag, the upsert goes through the server
  // route (canManageRoles-gated there); timestamps travel as ISO
  // strings, the jsonb shape. Null = seam unavailable, Firestore below.
  if (rolesSupaEnabled()) {
    const nowIso = new Date().toISOString();
    const written = await seamSetDoc(
      'roleDefinitions',
      slug,
      { slug, name: slug, description, updatedAt: nowIso, createdAt: nowIso },
      { merge: true }
    );
    if (written) {
      invalidateRoleDefinitionsCache();
      return;
    }
  }
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
