/**
 * The AI task generator's team registry, extracted from
 * src/app/api/ai-task-generator/route.ts (Custom Roles Fix Program,
 * RESOLUTION-AI plan s.5.2) so the registry is testable and the program
 * has one server registry module.
 *
 * The registry is built server-side from Firestore only; client-sent
 * arrays are never trusted (Oct 4 lesson) and this module exports no
 * function that accepts them. Behavior beyond the original builder
 * (plan s.5.3, contracts s.4.3):
 * - RegistryUser carries `additionalRoles` (roles doc first, users doc
 *   fallback when no roles doc exists), so the generator can see
 *   additionalRoles holders (invariant 9).
 * - A holder whose primary fails ONLY the role test (empty / 'member'
 *   / 'none') is included when an additional role is steerable: a
 *   catalog key other than 'member'/'member_basic', or a slug backed
 *   by a validated custom definition. Junk additionals never steer.
 * - An expired custom grant (contracts s.2.2 read-time derivation,
 *   customGrantStatus) is skipped: an expired grant matches nobody.
 * - Validated custom definitions carry title / parentRole / chapterId
 *   in the definitions list and are chapter-filtered; non-custom
 *   entries are byte-identical to the original builder.
 */

import { getDb } from './firebase-admin';
import { isCatalogRoleKey, normalizeRoleSlug } from '../role-catalog';
import {
  toCustomRoleDefinition,
  customRoleTitle,
  customGrantStatus,
  type CustomRoleDefinition,
} from '../custom-roles';

export interface RegistryUser {
  uid: string;
  name: string;
  role: string;
  /** Stored additional roles (normalised slugs, sorted); [] when none. */
  additionalRoles: string[];
}

export interface RegistryRoleDef {
  role: string;
  description: string;
  /** Populated ONLY for validated custom definitions (plan s.5.3.5). */
  title?: string;
  parentRole?: string;
  chapterId?: string;
}

export interface TeamRegistry {
  subordinates: RegistryUser[];
  roleDefinitions: RegistryRoleDef[];
  rolesByUid: Map<string, string>;
}

/**
 * Normalise a stored additionalRoles array: strings only, slug
 * normalised, empties dropped, deduped, the primary excluded, sorted
 * ascending for deterministic prompt output.
 */
function extractAdditionals(
  data: Record<string, unknown>,
  primaryRaw: unknown,
): string[] {
  const rawList = Array.isArray(data.additionalRoles) ? data.additionalRoles : [];
  const primary = typeof primaryRaw === 'string' ? normalizeRoleSlug(primaryRaw) : '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of rawList) {
    if (typeof entry !== 'string') continue;
    const slug = normalizeRoleSlug(entry);
    if (!slug || slug === primary || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out.sort();
}

/**
 * Build the team registry server-side with the Admin SDK so the AI always
 * assigns from fresh, authoritative role data. The client-sent arrays are
 * never trusted (stale snapshots, or a tampered client, would otherwise
 * steer assignments). Roles come from the `roles` collection first with
 * `users/{uid}.role` as fallback, mirroring the client filter: empty,
 * 'member' and 'none' roles are excluded.
 */
export async function buildTeamRegistry(chapterId?: string): Promise<TeamRegistry> {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');

  const [rolesSnap, usersSnap, defsSnap] = await Promise.all([
    db.collection('roles').get(),
    db.collection('users').get(),
    db.collection('roleDefinitions').get(),
  ]);
  const now = new Date();

  // Validate custom definitions first (plan s.5.3.2): only docs passing
  // the shared core's four-part test can steer or be listed as custom.
  const customDefs = new Map<string, CustomRoleDefinition>();
  defsSnap.forEach((d) => {
    const def = toCustomRoleDefinition(
      d.id,
      (d.data() || {}) as Record<string, unknown>,
    );
    if (def) customDefs.set(d.id, def);
  });

  const rolesByUid = new Map<string, string>();
  const rolesDocUids = new Set<string>();
  const additionalsByUid = new Map<string, string[]>();
  rolesSnap.forEach((d) => {
    rolesDocUids.add(d.id);
    const data = (d.data() || {}) as Record<string, unknown>;
    const r = data.role;
    if (typeof r === 'string' && r.trim()) rolesByUid.set(d.id, r.trim().toLowerCase());
    let additionals = extractAdditionals(data, data.role);
    // Contracts s.4.3: an expired custom grant matches nobody. The
    // grant record names the one expiring slug in expiresRoleKey.
    if (typeof data.expiresRoleKey === 'string' && data.expiresRoleKey !== '') {
      const grantSlug = data.expiresRoleKey;
      if (customGrantStatus(data, grantSlug, now) === 'expired') {
        const normalised = normalizeRoleSlug(grantSlug);
        additionals = additionals.filter((slug) => slug !== normalised);
      }
    }
    additionalsByUid.set(d.id, additionals);
  });

  const subordinates: RegistryUser[] = [];
  usersSnap.forEach((d) => {
    const data = d.data() || {};
    const fallback = typeof data.role === 'string' ? data.role.trim().toLowerCase() : '';
    const role = rolesByUid.get(d.id) || fallback;
    if (chapterId && typeof data.chapterId === 'string' && data.chapterId && data.chapterId !== chapterId) return;
    // Roles-first / users-fallback, exactly like the primary: the users
    // doc's additionals are read only when no roles doc exists.
    const additionalRoles = rolesDocUids.has(d.id)
      ? (additionalsByUid.get(d.id) ?? [])
      : extractAdditionals(data as Record<string, unknown>, data.role);
    const primarySteers = !!role && role !== 'member' && role !== 'none';
    if (!primarySteers) {
      // The primary failed ONLY the role test: a steerable additional
      // role still includes the holder (invariant 9). Junk additionals
      // and 'member'/'member_basic' never steer.
      const steered = additionalRoles.some(
        (slug) =>
          customDefs.has(slug) ||
          (isCatalogRoleKey(slug) && slug !== 'member' && slug !== 'member_basic'),
      );
      if (!steered) return;
    }
    const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const email = typeof data.email === 'string' ? data.email : '';
    subordinates.push({ uid: d.id, name: displayName || email || d.id, role, additionalRoles });
  });

  const roleDefinitions: RegistryRoleDef[] = [];
  defsSnap.forEach((d) => {
    const data = d.data() || {};
    const custom = customDefs.get(d.id);
    if (custom) {
      // A custom role never appears in another chapter's lists (spec s.4).
      if (chapterId && custom.chapterId !== chapterId) return;
      roleDefinitions.push({
        role: d.id,
        description: custom.description,
        title: customRoleTitle(custom, custom.slug),
        parentRole: custom.parentRoleKey,
        chapterId: custom.chapterId,
      });
      return;
    }
    const raw = data.description ?? data.responsibilities ?? '';
    roleDefinitions.push({ role: d.id, description: typeof raw === 'string' ? raw : '' });
  });

  return { subordinates, roleDefinitions, rolesByUid };
}

/**
 * Resolve the caller's role the same way the registry resolves subordinate
 * roles: roles/{uid}.role first, users/{uid}.role as fallback. A missing role
 * everywhere resolves to '' so the permission gate denies safely.
 */
export async function resolveCallerRole(uid: string, rolesByUid: Map<string, string>): Promise<string> {
  const fromRoles = rolesByUid.get(uid);
  if (fromRoles) return fromRoles;
  try {
    const db = getDb();
    if (!db) return '';
    const snap = await db.collection('users').doc(uid).get();
    const r = snap.data()?.role;
    return typeof r === 'string' ? r.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}
