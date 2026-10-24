/**
 * Governors register - shared internals for register.ts and term-sweep.ts
 * (Phase 2, spec C.1/C.2). Keeps the two writers out of a circular import
 * while sharing the error type, the history-event shape, and the P2-SYNC
 * role-sync adapter.
 *
 * History lives in the append-only subcollection
 * governors/{seatKey}/history/{eventId} (spec C.1), written in the same
 * batch as the seat mutation, with before/after holder snapshots.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  GOVERNORS_COLLECTION,
  GOVERNOR_HISTORY_SUBCOLLECTION,
  holderRoleKeyFor,
  type GovernorSeat,
  type SeatKey,
} from '@/lib/governors';

export class GovernorOpError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = 'GovernorOpError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function opError(code: string, message: string): GovernorOpError {
  const status =
    code === 'SEAT_NOT_FOUND'
      ? 404
      : code === 'FORBIDDEN' || code === 'FOUNDER_SEAT_LOCKED'
        ? 403
        : code === 'VERSION_CONFLICT' || code === 'ALREADY_SEATED' || code === 'SEAT_NOT_VACANT'
          ? 409
          : 422;
  return new GovernorOpError(code, status, message);
}

export function seatRef(db: Firestore, seatKey: SeatKey) {
  return db.collection(GOVERNORS_COLLECTION).doc(seatKey);
}

export function historyRef(db: Firestore, seatKey: SeatKey) {
  return db
    .collection(GOVERNORS_COLLECTION)
    .doc(seatKey)
    .collection(GOVERNOR_HISTORY_SUBCOLLECTION)
    .doc();
}

export interface SeatSnapshot {
  holderName: string | null;
  holderUid: string | null;
  status: string;
  termStart: unknown;
  termEnd: unknown;
}

export function seatSnapshot(seat: GovernorSeat | null): SeatSnapshot | null {
  if (!seat) return null;
  return {
    holderName: seat.holderName,
    holderUid: seat.holderUid,
    status: seat.status,
    termStart: seat.termStart ?? null,
    termEnd: seat.termEnd ?? null,
  };
}

export function historyEvent(args: {
  eventType: string;
  actorUid: string;
  actorRole?: string | null;
  before: GovernorSeat | null;
  after: GovernorSeat | null;
  recordRef?: string | null;
  reason?: string | null;
}) {
  return {
    eventType: args.eventType,
    actorUid: args.actorUid,
    actorRole: args.actorRole ?? null,
    at: FieldValue.serverTimestamp(),
    before: seatSnapshot(args.before),
    after: seatSnapshot(args.after),
    recordRef: args.recordRef ?? null,
    reason: args.reason ?? null,
  };
}

export async function readRoleStores(db: Firestore, uid: string) {
  const [userSnap, rolesSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('roles').doc(uid).get(),
  ]);
  return {
    userData: userSnap.exists ? (userSnap.data() as Record<string, unknown>) : undefined,
    userExists: userSnap.exists,
    rolesData: rolesSnap.exists ? (rolesSnap.data() as Record<string, unknown>) : undefined,
  };
}

/**
 * P2-SYNC ADAPTER: grant the category Governor role key (governor_founder /
 * governor_coopted / governor_member, spec C.1) to a holder in both stores.
 * Deliberately NOT Phase 1's resolver or the consent-gated assign route.
 *
 * Read-Burn A (plan §2.5 W14): this helper composes into a CALLER-owned
 * batch and cannot bust the identity cache (nothing is committed yet).
 * Any caller must call bustIdentity(holderUid) after its own
 * batch.commit() succeeds. (The committing callers in register.ts bust
 * at W14.)
 */
export function grantGovernorRole(
  batch: FirebaseFirestore.WriteBatch,
  db: Firestore,
  seatKey: SeatKey,
  holderUid: string,
  grantedBy: string,
) {
  const roleKey = holderRoleKeyFor(seatKey);
  batch.set(
    db.collection('roles').doc(holderUid),
    { role: roleKey, grantedBy, grantedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  batch.set(
    db.collection('users').doc(holderUid),
    { role: roleKey, displayRole: roleKey, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/**
 * P2-SYNC ADAPTER (spec C.2): restore the holder's prior role from
 * users/{uid}.previousRole (roles/{uid} fallback, else 'member') into BOTH
 * stores and clear previousRole. Skipped entirely for external holders.
 *
 * Read-Burn A (plan §2.5 W14/W15): this helper composes into a
 * CALLER-owned batch and cannot bust the identity cache (nothing is
 * committed yet). Any caller must call bustIdentity(holderUid) after
 * its own batch.commit() succeeds. (The committing callers in
 * register.ts bust at W14 and in term-sweep.ts at W15.)
 */
export function restorePriorRole(
  batch: FirebaseFirestore.WriteBatch,
  db: Firestore,
  holderUid: string,
  userData: Record<string, unknown> | undefined,
  rolesData: Record<string, unknown> | undefined,
  restoredBy: string,
) {
  const prior =
    (typeof userData?.previousRole === 'string' && (userData.previousRole as string)) ||
    (typeof rolesData?.previousRole === 'string' && (rolesData.previousRole as string)) ||
    'member';
  batch.set(
    db.collection('roles').doc(holderUid),
    {
      role: prior,
      grantedBy: restoredBy,
      grantedAt: FieldValue.serverTimestamp(),
      previousRole: FieldValue.delete(),
    },
    { merge: true },
  );
  batch.set(
    db.collection('users').doc(holderUid),
    {
      role: prior,
      displayRole: prior,
      previousRole: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
