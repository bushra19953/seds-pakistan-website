import { collection, doc, getDocs, serverTimestamp, Firestore } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';

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
