/**
 * Role-holder resolution for governance (Phase 2) server operations.
 *
 * The authoritative role store is roles/{uid} -> { role: 'slug' }
 * (query pattern verified in src/app/api/admin/roles/[slug]/route.ts).
 *
 * Vacancy is a first-class state: resolveRoleHolders returns [] when no
 * one holds the role. It never throws and never falls back to the
 * Founder; consumers must handle the empty list themselves.
 */

import type { Firestore } from 'firebase-admin/firestore';

/**
 * Return the uids of every current holder of `roleKey`.
 * Returns [] on vacancy and on any read failure (never throws).
 */
export async function resolveRoleHolders(
  db: Firestore,
  roleKey: string
): Promise<string[]> {
  try {
    const snap = await db.collection('roles').where('role', '==', roleKey).get();
    if (snap && Array.isArray((snap as any).docs)) {
      return (snap as any).docs.map((doc: any) => doc.id as string);
    }
    const uids: string[] = [];
    (snap as any)?.forEach?.((doc: any) => uids.push(doc.id as string));
    return uids;
  } catch {
    return [];
  }
}

/**
 * Return the role key held by `uid`, or null when the user holds no
 * role doc (or the read fails).
 */
export async function resolveUserRoleKey(
  db: Firestore,
  uid: string
): Promise<string | null> {
  // ADAPTER: Phase 1 resolver swap point - replace body with the Phase 1 canonical resolver when feat/bylaws-phase1 lands; signature stays.
  try {
    const snap = await db.collection('roles').doc(uid).get();
    if (!snap || !snap.exists) return null;
    const data = typeof snap.data === 'function' ? snap.data() : undefined;
    const role = (data as Record<string, unknown> | undefined)?.role;
    return typeof role === 'string' && role.length > 0 ? role : null;
  } catch {
    return null;
  }
}
