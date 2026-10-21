/**
 * Governors register - shared internals for register.ts and term-sweep.ts
 * (Phase 2, spec C.2). Keeps the two writers out of a circular import while
 * sharing the error type, the history-entry shape, and the P2-SYNC role-sync
 * adapter.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  GOVERNORS_COLLECTION,
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

export function historyEntry(args: {
  seatKey: SeatKey;
  event: string;
  actorUid: string;
  actorName?: string | null;
  details: Record<string, unknown>;
}) {
  return {
    seatKey: args.seatKey,
    event: args.event,
    actorUid: args.actorUid,
    actorName: args.actorName ?? null,
    at: FieldValue.serverTimestamp(),
    details: args.details,
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

/** P2-SYNC ADAPTER: grant the governor role key to a holder in both stores. */
export function grantGovernorRole(
  batch: FirebaseFirestore.WriteBatch,
  db: Firestore,
  seatKey: SeatKey,
  holderUid: string,
  grantedBy: string,
) {
  const roleKey = `governor_${seatKey}`;
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
 * P2-SYNC ADAPTER (spec C.2.2): restore the holder's prior role from
 * users/{uid}.previousRole (roles/{uid} fallback, else 'member') into BOTH
 * stores and clear previousRole. Skipped entirely for external holders.
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
