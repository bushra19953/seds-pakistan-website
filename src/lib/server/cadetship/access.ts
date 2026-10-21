/**
 * Cadetship authorization + team-lead resolution (phase2_spec.md Sections
 * F.4, F.5, F.8). Eligibility is ALWAYS resolved from the authoritative
 * roles/{uid} store at request time - never from a client-sent role.
 */

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { isFounderUid } from '@/lib/server/founder-gate';
import { resolveRoleHolders } from '@/lib/server/role-holders';
import type { CadetshipDoc } from '@/lib/cadetship/types';

type Firestore = admin.firestore.Firestore;

export const NMD_ROLE = 'national_membership_director';
export const CP_ROLE = 'chapter_president';
export const VP_ROLE = 'chapter_vice_president';
export const NGS_ROLE = 'national_general_secretary';
export const AUDIT_CHAIR_ROLE = 'national_audit_compliance_chair';

export interface CallerRole {
  roleKey: string | null;
  chapterId: string | null;
}

/** The caller's single role-store entry (roles/{uid}). */
export async function getCallerRole(db: Firestore, uid: string): Promise<CallerRole> {
  const snap = await db.collection('roles').doc(uid).get();
  if (!snap.exists) return { roleKey: null, chapterId: null };
  const data = snap.data() as { role?: unknown; chapterId?: unknown };
  return {
    roleKey: typeof data.role === 'string' ? data.role : null,
    chapterId: typeof data.chapterId === 'string' ? data.chapterId : null,
  };
}

export function isChapterOfficerOf(caller: CallerRole, chapterId: string): boolean {
  return (
    caller.roleKey != null &&
    caller.roleKey.startsWith('chapter_') &&
    caller.chapterId === chapterId
  );
}

export function isChapterPresidentOf(caller: CallerRole, chapterId: string): boolean {
  return caller.roleKey === CP_ROLE && caller.chapterId === chapterId;
}

export function isNmd(caller: CallerRole): boolean {
  return caller.roleKey === NMD_ROLE;
}

/** F.8 read access: subject, chapter officers of the chapter, NMD, Founder, NGS, Audit Chair. */
export function canReadCadetship(
  uid: string,
  caller: CallerRole,
  cadetship: Pick<CadetshipDoc, 'personUid' | 'chapterId'>,
): boolean {
  if (uid === cadetship.personUid) return true;
  if (isFounderUid(uid)) return true;
  if (isChapterOfficerOf(caller, cadetship.chapterId)) return true;
  return caller.roleKey === NMD_ROLE || caller.roleKey === NGS_ROLE || caller.roleKey === AUDIT_CHAIR_ROLE;
}

/** F.4 attesters: any chapter officer of the cadet's chapter, or the NMD. */
export function canAttest(caller: CallerRole, cadetship: Pick<CadetshipDoc, 'chapterId'>): boolean {
  return isChapterOfficerOf(caller, cadetship.chapterId) || isNmd(caller);
}

/**
 * F.5 team-lead resolution. The platform's tasks carry no teamLead field,
 * so the lead of the cadet's sprint task resolves as the task's assignerId
 * (the officer who set the work), falling back to its reviewerId. With no
 * resolvable sprint-task lead, the Chapter President's deputy
 * (chapter_vice_president holder of the cadet's chapter) is the lead. Null
 * means the CP-collapse rule applies (the CP submits both evaluations and
 * the record says so via singleEvaluatorReason).
 */
export async function resolveTeamLeadUid(
  db: Firestore,
  cadetship: Pick<CadetshipDoc, 'items' | 'chapterId'>,
): Promise<string | null> {
  const taskId = cadetship.items?.sprintTask?.taskId ?? null;
  if (taskId) {
    const taskSnap = await db.collection('tasks').doc(taskId).get();
    if (taskSnap.exists) {
      const task = taskSnap.data() as { assignerId?: unknown; reviewerId?: unknown };
      if (typeof task.assignerId === 'string' && task.assignerId) return task.assignerId;
      if (typeof task.reviewerId === 'string' && task.reviewerId) return task.reviewerId;
    }
  }
  const vps = await resolveRoleHolders(VP_ROLE, cadetship.chapterId);
  return vps.length > 0 ? vps[0] : null;
}

export async function loadCadetshipDoc(
  db: Firestore,
  id: string,
): Promise<{ ref: admin.firestore.DocumentReference; raw: Record<string, any> } | null> {
  const ref = db.collection('cadetships').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { ref, raw: snap.data() as Record<string, any> };
}

export function dbOrThrow(): Firestore {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');
  return db;
}
