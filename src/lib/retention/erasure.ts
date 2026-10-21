// Account erasure (Workstream F), matching the privacy promise:
// a member may request erasure; the request enters a 14-day
// cooling-off period (F-G1) during which it can be withdrawn; after
// that an admin executes it. Execution:
//   - the users doc becomes a non-identifying tombstone (kept so
//     historical records that reference the uid stay referable),
//   - the Firebase Auth account is deleted (erasure ONLY - Departed
//     members keep their Auth account and can return),
//   - retained records that carry the uid as a person reference
//     (points_ledger) are pseudonymised to a stable erased-<hash> id,
//   - the erasure_requests record itself is RETAINED as the audit
//     proof of the execution.
//
// SPEC-GAP(F): the draft never enumerated the tombstone field set or
// the pseudonymised collections; both are defined here from the
// privacy-promise shape and marked.

import { createHash } from 'node:crypto';

export const ERASURE_REQUESTS_COLLECTION = 'erasure_requests';
export const COOLING_OFF_DAYS = 14;

// F-G1 erasure promise text (shown at request time and on the admin
// erasure queue, so the promise the member saw is the one executed).
export const ERASURE_PROMISE_TEXT =
  'If you request erasure, your account enters a 14-day cooling-off period during which you can withdraw the request by signing in and contacting an admin. After 14 days an administrator will erase your account: your profile becomes a non-identifying tombstone, your sign-in is deleted, and records the society must keep for its registers are pseudonymised so they no longer identify you. The erasure request record itself is kept as proof the erasure happened.';

export type ErasureStatus = 'cooling_off' | 'executed' | 'withdrawn';

export interface ErasureDeps {
  db: {
    collection: (name: string) => any;
  };
  /** Deletes the Firebase Auth account. Erasure only; never Departed. */
  deleteAuthUser: (uid: string) => Promise<void>;
  writeAudit: (entry: Record<string, unknown>) => Promise<void>;
  now: () => Date;
}

export function pseudonymFor(uid: string): string {
  return `erased-${createHash('sha256').update(uid).digest('hex').slice(0, 12)}`;
}

export async function requestErasure(
  deps: ErasureDeps,
  uid: string,
  reason?: string,
): Promise<{ requestId: string; executeAfter: string }> {
  const existing = await deps.db
    .collection(ERASURE_REQUESTS_COLLECTION)
    .where('uid', '==', uid)
    .where('status', '==', 'cooling_off')
    .get();
  if (!existing.empty) {
    throw new Error('An erasure request is already in its cooling-off period for this account');
  }
  const now = deps.now();
  const executeAfter = new Date(
    now.getTime() + COOLING_OFF_DAYS * 24 * 60 * 60 * 1000,
  );
  const ref = await deps.db.collection(ERASURE_REQUESTS_COLLECTION).add({
    uid,
    status: 'cooling_off' as ErasureStatus,
    reason: reason ?? null,
    requestedAt: now.toISOString(),
    executeAfter: executeAfter.toISOString(),
    executedAt: null,
    executedBy: null,
  });
  await deps.writeAudit({
    type: 'ERASURE_REQUESTED',
    actorId: uid,
    targetId: uid,
    data: { requestId: ref.id, executeAfter: executeAfter.toISOString() },
  });
  return { requestId: ref.id, executeAfter: executeAfter.toISOString() };
}

// SPEC-GAP(F): tombstone field set for the users doc.
const TOMBSTONE_FIELDS: Record<string, unknown> = {
  memberStatus: 'erased',
  displayName: 'Erased member',
  email: null,
  photoURL: null,
  phoneNumber: null,
  phone: null,
  cnic: null,
  address: null,
  bio: null,
  hasApplied: false,
  applicationStatus: null,
};

export async function executeErasure(
  deps: ErasureDeps,
  requestId: string,
  executedBy: string,
): Promise<{ uid: string; pseudonym: string }> {
  const reqRef = deps.db.collection(ERASURE_REQUESTS_COLLECTION).doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new Error('Erasure request not found');
  const req = reqSnap.data() as {
    uid: string;
    status: ErasureStatus;
    executeAfter: string;
  };
  if (req.status !== 'cooling_off') {
    throw new Error(`Erasure request is ${req.status}, not cooling_off`);
  }
  if (deps.now().getTime() < Date.parse(req.executeAfter)) {
    throw new Error(
      `Cooling-off period has not ended (executable after ${req.executeAfter})`,
    );
  }
  const uid = req.uid;
  const pseudonym = pseudonymFor(uid);

  // 1. Tombstone the profile.
  await deps.db
    .collection('users')
    .doc(uid)
    .set(
      { ...TOMBSTONE_FIELDS, erasedAt: deps.now().toISOString() },
      { merge: true },
    );

  // 2. Mirror the erased status on the role record if one exists.
  const roleRef = deps.db.collection('roles').doc(uid);
  const roleSnap = await roleRef.get();
  if (roleSnap.exists) {
    await roleRef.update({ memberStatus: 'erased' });
  }

  // 3. Pseudonymise retained person-referencing records.
  const ledgerSnap = await deps.db
    .collection('points_ledger')
    .where('userId', '==', uid)
    .get();
  for (const doc of ledgerSnap.docs) {
    await doc.ref.update({ userId: pseudonym, erasedPseudonym: true });
  }

  // 4. Delete the sign-in (Auth). Last, so a failure above leaves the
  // member able to sign in and an admin able to retry.
  await deps.deleteAuthUser(uid);

  // 5. Close the request; the record is retained as proof.
  await reqRef.update({
    status: 'executed',
    executedAt: deps.now().toISOString(),
    executedBy,
    pseudonym,
  });

  await deps.writeAudit({
    type: 'ERASURE_EXECUTED',
    actorId: executedBy,
    targetId: uid,
    data: { requestId, pseudonym },
  });
  return { uid, pseudonym };
}

export async function withdrawErasure(
  deps: ErasureDeps,
  requestId: string,
  uid: string,
): Promise<void> {
  const reqRef = deps.db.collection(ERASURE_REQUESTS_COLLECTION).doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new Error('Erasure request not found');
  const req = reqSnap.data() as { uid: string; status: ErasureStatus };
  if (req.uid !== uid) throw new Error('Not your erasure request');
  if (req.status !== 'cooling_off') {
    throw new Error(`Erasure request is ${req.status}, not cooling_off`);
  }
  await reqRef.update({ status: 'withdrawn', withdrawnAt: deps.now().toISOString() });
  await deps.writeAudit({
    type: 'ERASURE_WITHDRAWN',
    actorId: uid,
    targetId: uid,
    data: { requestId },
  });
}
