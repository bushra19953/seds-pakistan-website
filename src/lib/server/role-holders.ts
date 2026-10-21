// ADAPTER: thin local stand-in for the Phase 2 W0 substrate role-holders
// resolver (phase2_spec.md Section 0.4). Replace with the canonical W0 /
// Phase 1 resolver at merge time; the exported signatures are the contract
// and must not change.
//
// Reads the current authoritative store shape in this repo: roles/{uid}
// documents carrying { role: '<roleKey>', chapterId?: string }. When the
// Phase 1 single-store migration lands, only this file changes.
//
// Vacancy is a first-class state: an office with no holder returns [] / null.
// This module never throws and never falls back to the Founder.

import { getDb } from '@/lib/server/firebase-admin';

/**
 * All uids currently holding roleKey. When chapterId is given and role docs
 * carry a chapterId field, only holders of that chapter are returned; docs
 * without a chapterId field are treated as national (unscoped) holders and
 * are excluded from a chapter-scoped query.
 */
export async function resolveRoleHolders(
  roleKey: string,
  chapterId?: string | null,
): Promise<string[]> {
  try {
    const db = getDb();
    if (!db) return [];
    const snap = await db.collection('roles').where('role', '==', roleKey).get();
    const uids: string[] = [];
    snap.forEach((doc) => {
      if (chapterId) {
        const docChapter = (doc.data() as { chapterId?: unknown }).chapterId;
        if (typeof docChapter === 'string' && docChapter !== chapterId) return;
        if (typeof docChapter !== 'string') return;
      }
      uids.push(doc.id);
    });
    return uids;
  } catch {
    return [];
  }
}

/** The current holder of an office, or null when the office is vacant. */
export async function resolveOfficeHolder(
  officeRole: string,
  chapterId?: string | null,
): Promise<string | null> {
  const holders = await resolveRoleHolders(officeRole, chapterId ?? null);
  return holders.length > 0 ? holders[0] : null;
}

/** True when the uid currently holds roleKey (optionally within a chapter). */
export async function userHoldsRole(
  uid: string,
  roleKey: string,
  chapterId?: string | null,
): Promise<boolean> {
  try {
    const db = getDb();
    if (!db || !uid) return false;
    const doc = await db.collection('roles').doc(uid).get();
    if (!doc.exists) return false;
    const data = doc.data() as { role?: unknown; chapterId?: unknown };
    if (data.role !== roleKey) return false;
    if (chapterId) {
      return data.chapterId === chapterId;
    }
    return true;
  } catch {
    return false;
  }
}

/** The single role key a uid currently holds, or null. */
export async function resolveUserRoleKey(uid: string): Promise<string | null> {
  try {
    const db = getDb();
    if (!db || !uid) return null;
    const doc = await db.collection('roles').doc(uid).get();
    if (!doc.exists) return null;
    const role = (doc.data() as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}
