/**
 * Member lifecycle: soft-delete (Departed) handling for users.
 *
 * Workstream F, Section 2.5 / 5.4: this module REPLACES every member
 * hard-delete path. No function in here deletes a user doc, a roles/{uid}
 * doc, or any other member record. Departure is a status change plus the
 * cascade the old hierarchy DELETE handler performed (managerId nulling
 * on direct reports, mirrored into reporting_relationships), with open
 * positions ENDED instead of deleted, and an audit_logs entry.
 *
 * Firebase Auth is NOT touched on depart (or on reinstate). Auth deletion
 * belongs only to the separate erasure flow, which is out of scope here.
 */

import { syncDirectRelationship } from '@/lib/server/hierarchy';
import { bustIdentity } from '@/lib/server/identity-cache';

export type MemberStatus = 'active' | 'departed' | 'erased';

export const MEMBER_STATUSES: readonly MemberStatus[] = [
  'active',
  'departed',
  'erased',
] as const;

/**
 * Typed error for a lifecycle transition the current status forbids.
 * Routes map this to HTTP 409; anything else is a 500.
 */
export class InvalidMemberTransitionError extends Error {
  code = 'INVALID_MEMBER_TRANSITION';
  fromStatus: MemberStatus;
  attemptedAction: 'depart' | 'reinstate';

  constructor(fromStatus: MemberStatus, attemptedAction: 'depart' | 'reinstate') {
    super(
      `Cannot ${attemptedAction} a member whose status is '${fromStatus}'`
    );
    this.name = 'InvalidMemberTransitionError';
    this.fromStatus = fromStatus;
    this.attemptedAction = attemptedAction;
  }
}

export class MemberNotFoundError extends Error {
  code = 'MEMBER_NOT_FOUND';
  uid: string;

  constructor(uid: string) {
    super(`User not found: ${uid}`);
    this.name = 'MemberNotFoundError';
    this.uid = uid;
  }
}

// SPEC-GAP(F): the spec draft (ws-f.md) names the lifecycle fields and the
// D1-D5 conversions but its detailed design sections (5.4 / 7.1) were never
// written, so the exact Firestore handle type is not pinned there. This
// module takes the Admin SDK Firestore instance as a parameter (the value
// returned by getDb() from src/lib/server/firebase-admin.ts) and only uses
// the collection/doc/batch surface the old DELETE handler used, so tests
// can pass a mock with the same surface.
type FirestoreDb = FirebaseFirestore.Firestore;

type UserDocLike =
  | Record<string, unknown>
  | { data: () => Record<string, unknown> | undefined }
  | null
  | undefined;

/**
 * Read the lifecycle status off a user doc (plain data object, or a
 * snapshot-like object with a data() method). A doc with no memberStatus
 * field is a pre-lifecycle member and reads as 'active'. An unrecognised
 * stored value also reads as 'active' rather than inventing a status.
 */
export function getMemberStatus(userDoc: UserDocLike): MemberStatus {
  if (!userDoc) return 'active';
  const data: Record<string, unknown> | undefined =
    typeof (userDoc as { data?: unknown }).data === 'function'
      ? (userDoc as { data: () => Record<string, unknown> | undefined }).data()
      : (userDoc as Record<string, unknown>);
  const raw = data?.memberStatus;
  if (raw === 'departed' || raw === 'erased' || raw === 'active') return raw;
  return 'active';
}

export function isActiveMember(userDoc: UserDocLike): boolean {
  return getMemberStatus(userDoc) === 'active';
}

// ADAPTER(phase1-role-store): Phase 1's authoritative store (roles/{uid} + role_history) is a parallel build. This adapter appends a role_history doc { uid, action: 'departed'|'reinstated', actorUid, at } and sets a memberStatus mirror field on roles/{uid} IF that doc exists. It NEVER deletes roles/{uid}. Swap for the Phase 1 store API when it lands.
export async function applyRoleStoreLifecycle(
  db: FirestoreDb,
  uid: string,
  action: 'departed' | 'reinstated',
  actorUid: string
): Promise<void> {
  const at = new Date();

  await db.collection('role_history').add({ uid, action, actorUid, at });

  const roleRef = db.collection('roles').doc(uid);
  const roleSnap = await roleRef.get();
  if (roleSnap.exists) {
    await roleRef.update({
      memberStatus: action === 'departed' ? 'departed' : 'active',
    });
  }
}

/**
 * End (never delete) every open position held by uid.
 * A position is open when endDate is null or absent (src/app/api/positions
 * creates current positions with endDate: null and filters activeOnly on
 * endDate == null).
 */
async function endOpenPositions(
  db: FirestoreDb,
  uid: string,
  endedAt: Date
): Promise<number> {
  // SPEC-GAP(F): positions docs key the holder as `userId` in the only
  // creation path in the repo (src/app/api/positions/route.ts POST). The
  // spec does not name the field, so a second query on `uid` is run as a
  // defensive sweep for any doc written by another path; matches are
  // de-duplicated by doc id.
  const byId = new Map<string, FirebaseFirestore.DocumentSnapshot>();

  const byUserId = await db
    .collection('positions')
    .where('userId', '==', uid)
    .get();
  for (const docSnap of byUserId.docs) byId.set(docSnap.id, docSnap);

  const byUid = await db.collection('positions').where('uid', '==', uid).get();
  for (const docSnap of byUid.docs) byId.set(docSnap.id, docSnap);

  let ended = 0;
  for (const docSnap of byId.values()) {
    const data = docSnap.data() as Record<string, unknown> | undefined;
    const endDate = data?.endDate;
    if (endDate !== null && endDate !== undefined) continue; // already ended
    await docSnap.ref.update({ endDate: endedAt, endedReason: 'member_departed' });
    ended++;
  }
  return ended;
}

/**
 * Mark a member Departed (soft delete). Reuses the D1 cascade from
 * src/app/api/admin/hierarchy/user/route.ts DELETE (lines 70-102):
 * direct reports get managerId nulled in a batch, and each null is
 * mirrored into reporting_relationships via syncDirectRelationship,
 * exactly as that handler did. Unlike that handler, the user doc itself
 * is updated, never deleted.
 */
export async function departUser(
  db: FirestoreDb,
  uid: string,
  actorUid: string,
  reason: string
): Promise<{ uid: string; memberStatus: MemberStatus }> {
  if (!uid) throw new TypeError('[member-lifecycle] uid is required');
  if (!actorUid) throw new TypeError('[member-lifecycle] actorUid is required');
  if (!reason || reason.trim().length < 10) {
    throw new Error('[member-lifecycle] depart reason is required (minimum 10 characters)');
  }

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new MemberNotFoundError(uid);

  const currentStatus = getMemberStatus(
    userSnap.data() as Record<string, unknown> | undefined
  );
  if (currentStatus !== 'active') {
    throw new InvalidMemberTransitionError(currentStatus, 'depart');
  }

  const departedAt = new Date();

  // 1. Status change on the user doc itself. The doc is retained in full:
  //    applications, warnings, positions history and audit references to
  //    this uid all keep resolving after departure.
  await userRef.update({
    memberStatus: 'departed',
    departedAt,
    departedBy: actorUid,
    departReason: reason,
  });

  // 2. D1 cascade, reused: null managerId on every direct report, then
  //    mirror each null into reporting_relationships so no ghost edge
  //    points at the departed member as a manager.
  const allReports = await db
    .collection('users')
    .where('managerId', '==', uid)
    .get();
  if (!allReports.empty) {
    const batch = db.batch();
    const reportIds: string[] = [];
    allReports.docs.forEach((docSnap) => {
      batch.update(docSnap.ref, { managerId: null });
      reportIds.push(docSnap.id);
    });
    await batch.commit();

    for (const reportId of reportIds) {
      await syncDirectRelationship(reportId, null, actorUid);
    }
  }

  // 3. End open positions instead of deleting anything.
  await endOpenPositions(db, uid, departedAt);

  // 4. Role store: history entry + status mirror, never a delete.
  await applyRoleStoreLifecycle(db, uid, 'departed', actorUid);

  // 5. Audit. Firebase Auth is intentionally NOT touched on depart.
  await db.collection('audit_logs').add({
    action: 'MEMBER_DEPARTED',
    actorUid,
    targetUid: uid,
    reason,
    at: departedAt,
  });

  // Read-Burn A (§2.5 W8): memberStatus changed on users + roles.
  bustIdentity(uid);
  return { uid, memberStatus: 'departed' };
}

/**
 * Bring a Departed member back to active.
 *
 * Positions are NOT auto-restored: ending a position was a real-world
 * handover, so re-appointment goes through the normal positions flow.
 * Only the lifecycle fields are reversed, and the departure itself stays
 * on the record as a departedHistory entry.
 */
export async function reinstateUser(
  db: FirestoreDb,
  uid: string,
  actorUid: string
): Promise<{ uid: string; memberStatus: MemberStatus }> {
  if (!uid) throw new TypeError('[member-lifecycle] uid is required');
  if (!actorUid) throw new TypeError('[member-lifecycle] actorUid is required');

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new MemberNotFoundError(uid);

  const data = (userSnap.data() || {}) as Record<string, unknown>;
  const currentStatus = getMemberStatus(data);
  if (currentStatus !== 'departed') {
    throw new InvalidMemberTransitionError(currentStatus, 'reinstate');
  }

  const reinstatedAt = new Date();
  const existingHistory = Array.isArray(data.departedHistory)
    ? (data.departedHistory as unknown[])
    : [];
  const historyEntry = {
    departedAt: data.departedAt ?? null,
    departedBy: data.departedBy ?? null,
    departReason: data.departReason ?? null,
    reinstatedAt,
    reinstatedBy: actorUid,
  };

  // SPEC-GAP(F): the spec does not say how departedHistory is appended.
  // A read-modify-write of the array already on the doc is used (rather
  // than FieldValue.arrayUnion) so the behaviour is identical against a
  // mocked db in tests and the Admin SDK in production; departures are
  // rare, single-actor admin actions, so the race window is negligible.
  await userRef.update({
    memberStatus: 'active',
    departedAt: null,
    departedBy: null,
    departReason: null,
    departedHistory: [...existingHistory, historyEntry],
  });

  await applyRoleStoreLifecycle(db, uid, 'reinstated', actorUid);

  await db.collection('audit_logs').add({
    action: 'MEMBER_REINSTATED',
    actorUid,
    targetUid: uid,
    at: reinstatedAt,
  });

  // Read-Burn A (§2.5 W8): memberStatus changed on users + roles.
  bustIdentity(uid);
  return { uid, memberStatus: 'active' };
}
