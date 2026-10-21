/**
 * Compliance route access helpers (phase2_spec.md Sections G.6-G.8).
 * Office holding is resolved from the authoritative role store at
 * request time - never from a client-sent role and never from an
 * instance snapshot.
 */

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { userHoldsRole, resolveUserRoleKey } from '@/lib/server/compliance-role-holders';
import { AUDIT_CHAIR_ROLE } from '@/lib/compliance/seed-data';

export { AUDIT_CHAIR_ROLE };
export const NGS_ROLE_KEY = 'national_general_secretary';
export const PRESIDENT_ROLE_KEY = 'president_national';

type Firestore = admin.firestore.Firestore;

export function dbOrThrow(): Firestore {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');
  return db;
}

export async function isAuditChair(uid: string): Promise<boolean> {
  return userHoldsRole(uid, AUDIT_CHAIR_ROLE);
}

export async function isNgs(uid: string): Promise<boolean> {
  return userHoldsRole(uid, NGS_ROLE_KEY);
}

export async function callerRoleKey(uid: string): Promise<string | null> {
  return resolveUserRoleKey(uid);
}

export async function displayNameOf(db: Firestore, uid: string | null): Promise<string | null> {
  if (!uid) return null;
  const snap = await db.collection('users').doc(uid).get();
  const name = snap.data()?.displayName;
  return typeof name === 'string' ? name : null;
}

export async function loadObligation(
  db: Firestore,
  id: string,
): Promise<{ ref: admin.firestore.DocumentReference; data: Record<string, any> } | null> {
  const ref = db.collection('compliance_obligations').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { ref, data: snap.data() as Record<string, any> };
}

export async function loadNotice(
  db: Firestore,
  id: string,
): Promise<{ ref: admin.firestore.DocumentReference; data: Record<string, any> } | null> {
  const ref = db.collection('default_notices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { ref, data: snap.data() as Record<string, any> };
}
