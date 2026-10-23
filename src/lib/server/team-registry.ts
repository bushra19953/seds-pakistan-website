/**
 * The AI task generator's team registry, extracted verbatim from
 * src/app/api/ai-task-generator/route.ts (Custom Roles Fix Program,
 * RESOLUTION-AI plan s.5.2) so the registry is testable and the program
 * has one server registry module. Behavior at extraction: identical to
 * the route-local builder it replaces.
 */

import { getDb } from './firebase-admin';

export interface RegistryUser {
  uid: string;
  name: string;
  role: string;
}

export interface RegistryRoleDef {
  role: string;
  description: string;
}

export interface TeamRegistry {
  subordinates: RegistryUser[];
  roleDefinitions: RegistryRoleDef[];
  rolesByUid: Map<string, string>;
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

  const rolesByUid = new Map<string, string>();
  rolesSnap.forEach((d) => {
    const r = d.data()?.role;
    if (typeof r === 'string' && r.trim()) rolesByUid.set(d.id, r.trim().toLowerCase());
  });

  const subordinates: RegistryUser[] = [];
  usersSnap.forEach((d) => {
    const data = d.data() || {};
    const fallback = typeof data.role === 'string' ? data.role.trim().toLowerCase() : '';
    const role = rolesByUid.get(d.id) || fallback;
    if (!role || role === 'member' || role === 'none') return;
    if (chapterId && typeof data.chapterId === 'string' && data.chapterId && data.chapterId !== chapterId) return;
    const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const email = typeof data.email === 'string' ? data.email : '';
    subordinates.push({ uid: d.id, name: displayName || email || d.id, role });
  });

  const roleDefinitions: RegistryRoleDef[] = [];
  defsSnap.forEach((d) => {
    const data = d.data() || {};
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
