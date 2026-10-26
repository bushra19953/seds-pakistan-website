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
import {
  identityPrimaryFlagOn,
  primaryIdentityGet,
  primaryIdentitySet,
} from '../supa-identity-primary';

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
  let userData = userSnap.exists ? (userSnap.data() as Record<string, unknown>) : undefined;
  let userExists = userSnap.exists;
  let rolesData = rolesSnap.exists ? (rolesSnap.data() as Record<string, unknown>) : undefined;
  if (await identityPrimaryFlagOn('roles')) {
    // PRIMACY (G-ROLE-5, IC-11): the previousRole stash/restore source
    // is the PRIMARY store. A primary doc, when it exists, replaces
    // the Firestore copy wholesale (never merged — H-06's
    // stale-mirror rule); absence on the primary falls back to the
    // Firestore read the reverse mirrors keep fresh.
    const [pUser, pRoles] = await Promise.all([
      primaryIdentityGet('roles', 'users', uid),
      primaryIdentityGet('roles', 'roles', uid),
    ]);
    if (pUser?.exists) {
      userData = pUser.data;
      userExists = true;
    }
    if (pRoles?.exists) rolesData = pRoles.data;
  }
  return { userData, userExists, rolesData };
}

/* ---------------------------------------------------------------
 * WRITE PRIMACY (identity full build, G-ROLE-5).
 *
 * grantGovernorRole / restorePriorRole / stashPreviousRole compose
 * into a CALLER-owned Firestore batch (sync, unchanged — IC-14-style
 * caller contract). Under isSupaPrimary('roles') they ALSO record
 * their roles+users ops in a registry keyed by the batch object;
 * the committing caller awaits flushGovernorPrimaryOps(batch)
 * immediately BEFORE batch.commit(), which applies the recorded ops
 * to the adapter in recorded order (primary first, loud on failure —
 * a primary failure means the Firestore batch never commits). The
 * Firestore batch then commits as the reverse mirror for the
 * roles/users ops; it still carries the governors-seat writes, which
 * are Firestore-native in this program, so a batch-commit failure
 * keeps surfacing as an operation error exactly as today (named
 * split-commit divergence: primary ahead, seat write failed).
 * Deliberately NOT routed through assignRole: no roleHistory, no
 * consent gate (the governors spec excludes both) — the primary ops
 * therefore write NO roleHistory row on either store (IC-11).
 */

interface GovernorPrimaryOp {
  collection: 'roles' | 'users';
  id: string;
  data: Record<string, unknown>;
}

const governorPrimaryOps = new WeakMap<object, GovernorPrimaryOp[]>();

function recordGovernorPrimaryOp(
  batch: FirebaseFirestore.WriteBatch,
  collection: 'roles' | 'users',
  id: string,
  data: Record<string, unknown>,
): void {
  const ops = governorPrimaryOps.get(batch) ?? [];
  ops.push({ collection, id, data });
  governorPrimaryOps.set(batch, ops);
}

export async function flushGovernorPrimaryOps(
  batch: FirebaseFirestore.WriteBatch,
): Promise<boolean> {
  if (!(await identityPrimaryFlagOn('roles'))) return false;
  const ops = governorPrimaryOps.get(batch) ?? [];
  for (const op of ops) {
    await primaryIdentitySet('roles', op.collection, op.id, op.data, { merge: true });
  }
  return ops.length > 0;
}

/** The previousRole stash (R-07/U-26), composed exactly as the
 * register's seat flow composed it inline, plus primacy recording. */
export function stashPreviousRole(
  batch: FirebaseFirestore.WriteBatch,
  db: Firestore,
  holderUid: string,
  currentRole: string,
) {
  const usersData = { previousRole: currentRole, updatedAt: FieldValue.serverTimestamp() };
  const rolesData = { previousRole: currentRole };
  batch.set(db.collection('users').doc(holderUid), usersData, { merge: true });
  batch.set(db.collection('roles').doc(holderUid), rolesData, { merge: true });
  recordGovernorPrimaryOp(batch, 'users', holderUid, usersData);
  recordGovernorPrimaryOp(batch, 'roles', holderUid, rolesData);
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
  const rolesData = { role: roleKey, grantedBy, grantedAt: FieldValue.serverTimestamp() };
  const usersData = { role: roleKey, displayRole: roleKey, updatedAt: FieldValue.serverTimestamp() };
  batch.set(db.collection('roles').doc(holderUid), rolesData, { merge: true });
  batch.set(db.collection('users').doc(holderUid), usersData, { merge: true });
  recordGovernorPrimaryOp(batch, 'roles', holderUid, rolesData);
  recordGovernorPrimaryOp(batch, 'users', holderUid, usersData);
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
  const rolesRestore = {
    role: prior,
    grantedBy: restoredBy,
    grantedAt: FieldValue.serverTimestamp(),
    previousRole: FieldValue.delete(),
  };
  const usersRestore = {
    role: prior,
    displayRole: prior,
    previousRole: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  batch.set(db.collection('roles').doc(holderUid), rolesRestore, { merge: true });
  batch.set(db.collection('users').doc(holderUid), usersRestore, { merge: true });
  recordGovernorPrimaryOp(batch, 'roles', holderUid, rolesRestore);
  recordGovernorPrimaryOp(batch, 'users', holderUid, usersRestore);
}
