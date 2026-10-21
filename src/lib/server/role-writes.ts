/**
 * THE single role write path (Phase 1, spec B.1/B.4).
 *
 * Every role change in the system goes through this module: one
 * transaction updates roles/{uid} (authoritative), the users/{uid}
 * mirror, an append-only roleHistory record, an audit_logs entry, and the
 * authority_refresh signal. The previous hand-rolled writers failed
 * silently (swallowed catches, mirror drift); this module throws
 * RoleWriteError on every guard failure and never catches its own writes.
 *
 * Consumers: POST /api/admin/roles/write, the issue-warning restage, the
 * roles/[slug] DELETE restage, the hierarchy shell workflows, and the
 * migration tooling (apply mode only, behind its own hard gates).
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type CatalogRoleKey,
  isCatalogRoleKey,
  scopeOf,
  rankOf,
  effectiveRoleOf,
  sortAdditionalRoles,
} from '../role-catalog';
import { isFounderUid } from '@/config/founder';

export type RoleWriteSource =
  | 'admin_ui'
  | 'authority_inspector'
  | 'superadmin_page'
  | 'warning_demotion'
  | 'hierarchy'
  | 'self_service_signup'
  | 'reconciliation_repair'
  | 'migration';

export type RoleWriteErrorCode =
  | 'unknown_role'
  | 'derived_role_not_assignable'
  | 'reserved_role'
  | 'invalid_reason'
  | 'chapter_required'
  | 'actor_not_authorized'
  | 'user_not_found'
  | 'write_failed';

export class RoleWriteError extends Error {
  code: RoleWriteErrorCode;
  httpStatus: number;
  constructor(code: RoleWriteErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'RoleWriteError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface RoleDoc {
  role: CatalogRoleKey;
  additionalRoles: CatalogRoleKey[];
  chapterId: string | null;
  grantedBy?: string;
  grantedAt?: unknown;
  lastChangedBy: string;
  updatedAt: unknown;
  source: RoleWriteSource;
  schemaVersion: 2;
}

export interface AssignRoleInput {
  uid: string;
  role: CatalogRoleKey;
  additionalRoles?: CatalogRoleKey[];
  chapterId?: string | null;
  actorUid: string;
  reason: string;
  source: RoleWriteSource;
  consentRequestId?: string | null;
  idempotencyKey?: string;
}

export interface AssignRoleResult {
  roleDoc: RoleDoc;
  previousEffectiveRole: CatalogRoleKey | null;
  newEffectiveRole: CatalogRoleKey;
  alreadyApplied: boolean;
}

type Db = Firestore;

const ROLE_HISTORY = 'roleHistory';
const MIN_REASON_LENGTH = 10;

function validateCommon(input: { uid: string; actorUid: string; reason: string }): void {
  if (!input.uid) throw new RoleWriteError('user_not_found', 400, 'uid is required');
  if (!input.actorUid) throw new RoleWriteError('actor_not_authorized', 400, 'actorUid is required');
  if (!input.reason || input.reason.trim().length < MIN_REASON_LENGTH) {
    throw new RoleWriteError(
      'invalid_reason',
      400,
      `A reason of at least ${MIN_REASON_LENGTH} characters is required for an auditable role change`,
    );
  }
}

function validateRoleKey(key: string): asserts key is CatalogRoleKey {
  if (!isCatalogRoleKey(key)) {
    throw new RoleWriteError('unknown_role', 400, `Role "${key}" is not in the catalog`);
  }
  if (key === 'member_officer') {
    throw new RoleWriteError(
      'derived_role_not_assignable',
      400,
      'member_officer is a computed label (Art. 9.4) and is never assigned directly',
    );
  }
}

/**
 * The founder gate: founder_patron, and any R5/R4 key, may only be granted
 * by the Founder. Enforced here so no caller can bypass it.
 */
function validateActorForRole(actorUid: string, role: CatalogRoleKey, targetUid: string): void {
  const rank = rankOf(role);
  if ((rank === 'R5' || rank === 'R4') && !isFounderUid(actorUid)) {
    throw new RoleWriteError(
      'actor_not_authorized',
      403,
      `Granting ${role} requires the Founder as actor`,
    );
  }
  if (role === 'founder_patron' && !isFounderUid(targetUid)) {
    throw new RoleWriteError(
      'reserved_role',
      403,
      'founder_patron may only be held by the Founder',
    );
  }
}

interface PreviousState {
  role: CatalogRoleKey | null;
  additionalRoles: CatalogRoleKey[];
  chapterId: string | null;
  grantedBy?: string;
  grantedAt?: unknown;
  existed: boolean;
}

async function findByIdempotencyKey(
  db: Db,
  idempotencyKey: string | undefined,
): Promise<boolean> {
  if (!idempotencyKey) return false;
  const snap = await db
    .collection(ROLE_HISTORY)
    .where('idempotencyKey', '==', idempotencyKey)
    .limit(1)
    .get();
  return !snap.empty;
}

export interface RoleChangeEventInput {
  uid: string;
  newRole: {
    role: CatalogRoleKey;
    additionalRoles?: CatalogRoleKey[];
    chapterId?: string | null;
  };
  actorUid: string;
  reason: string;
  capturePrevious: true;
  source: RoleWriteSource;
  consentRequestId?: string | null;
  idempotencyKey?: string;
  /** Injectable clock for tests; defaults to a server timestamp sentinel. */
  timestamp?: unknown;
}

/**
 * Compose one role change into a caller-owned batch (spec B.4), for
 * callers whose surrounding operation must commit atomically with other
 * writes (issue-warning). Reads the previous roles doc and users doc
 * BEFORE composing; never reads inside the batch. History uses
 * action 'grant' when no previous primary existed, else 'change'.
 *
 * Returns the new effective role. Callers executing repairs that must not
 * fail the surrounding operation forever use this inside `allSettled`
 * AFTER the primary write (see the issue-warning restage).
 */
export async function addRoleChangeToBatch(
  db: Db,
  batch: FirebaseFirestore.WriteBatch,
  input: RoleChangeEventInput,
): Promise<{ newEffectiveRole: CatalogRoleKey; previous: PreviousState }> {
  validateCommon(input);
  validateRoleKey(input.newRole.role);
  for (const extra of input.newRole.additionalRoles ?? []) validateRoleKey(extra);
  validateActorForRole(input.actorUid, input.newRole.role, input.uid);

  const roleRef = db.collection('roles').doc(input.uid);
  const userRef = db.collection('users').doc(input.uid);
  const [roleSnap, userSnap] = await Promise.all([roleRef.get(), userRef.get()]);
  const existing = roleSnap.exists ? (roleSnap.data() as Record<string, unknown>) : null;
  const previous: PreviousState = {
    role: (existing?.role as CatalogRoleKey) ?? null,
    additionalRoles: Array.isArray(existing?.additionalRoles)
      ? (existing.additionalRoles as CatalogRoleKey[])
      : [],
    chapterId: (existing?.chapterId as string | null) ?? (userSnap.data()?.chapterId as string | null) ?? null,
    grantedBy: existing?.grantedBy as string | undefined,
    grantedAt: existing?.grantedAt,
    existed: roleSnap.exists,
  };

  const additionalRoles = sortAdditionalRoles(input.newRole.role, input.newRole.additionalRoles ?? []);
  const chapterId =
    input.newRole.chapterId !== undefined ? input.newRole.chapterId : previous.chapterId;
  if (scopeOf(input.newRole.role) === 'chapter' && !chapterId) {
    throw new RoleWriteError(
      'chapter_required',
      400,
      `Role ${input.newRole.role} is chapter-scoped and requires a chapterId`,
    );
  }
  const effective = effectiveRoleOf(input.newRole.role, additionalRoles);
  const now = input.timestamp ?? FieldValue.serverTimestamp();

  const roleDoc: Record<string, unknown> = {
    role: input.newRole.role,
    additionalRoles,
    chapterId: chapterId ?? null,
    lastChangedBy: input.actorUid,
    updatedAt: now,
    source: input.source,
    schemaVersion: 2,
  };
  // grantedBy / grantedAt are write-once (Art. 16.2 provenance).
  if (!previous.grantedBy) {
    roleDoc.grantedBy = input.actorUid;
    roleDoc.grantedAt = now;
  }
  batch.set(roleRef, roleDoc, { merge: true });

  const mirror: Record<string, unknown> = {
    role: effective,
    displayRole: effective,
    updatedAt: now,
    roleSource: 'roles',
  };
  if (additionalRoles.length > 0) {
    mirror.additionalRoles = additionalRoles;
  } else {
    mirror.additionalRoles = FieldValue.delete();
  }
  batch.set(userRef, mirror, { merge: true });

  const historyRef = db.collection(ROLE_HISTORY).doc();
  batch.set(historyRef, {
    uid: input.uid,
    roleKey: input.newRole.role,
    action: previous.existed ? 'change' : 'grant',
    previousRole: previous.role,
    newRole: input.newRole.role,
    previousAdditionalRoles: previous.additionalRoles,
    newAdditionalRoles: additionalRoles,
    previousEffectiveRole: previous.role
      ? effectiveRoleOf(previous.role, previous.additionalRoles)
      : null,
    effectiveRole: effective,
    chapterId: chapterId ?? null,
    grantedBy: input.actorUid,
    actorUid: input.actorUid,
    reason: input.reason.trim(),
    source: input.source,
    consentRequestId: input.consentRequestId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
  });

  const auditRef = db.collection('audit_logs').doc();
  batch.set(auditRef, {
    action: 'role_change',
    actorUid: input.actorUid,
    targetUserId: input.uid,
    targetRole: effective,
    details: {
      previousRole: previous.role,
      newRole: input.newRole.role,
      previousAdditionalRoles: previous.additionalRoles,
      newAdditionalRoles: additionalRoles,
      reason: input.reason.trim(),
      source: input.source,
      consentRequestId: input.consentRequestId ?? null,
    },
    createdAt: now,
  });

  batch.set(
    db.collection('authority_refresh').doc(input.uid),
    { requestedAt: now, reason: 'role_change' },
    { merge: true },
  );

  return { newEffectiveRole: effective, previous };
}

/**
 * Assign (grant or change) a role: one transaction composing roles +
 * mirror + roleHistory + audit + authority_refresh. Idempotent on
 * idempotencyKey. Throws RoleWriteError; never swallows.
 */
export async function assignRole(db: Db, input: AssignRoleInput): Promise<AssignRoleResult> {
  validateCommon(input);
  validateRoleKey(input.role);
  for (const extra of input.additionalRoles ?? []) validateRoleKey(extra);
  validateActorForRole(input.actorUid, input.role, input.uid);

  if (await findByIdempotencyKey(db, input.idempotencyKey)) {
    const current = await db.collection('roles').doc(input.uid).get();
    const data = current.data() as Record<string, unknown> | undefined;
    const role = (data?.role as CatalogRoleKey) ?? input.role;
    const additional = Array.isArray(data?.additionalRoles)
      ? (data.additionalRoles as CatalogRoleKey[])
      : [];
    return {
      roleDoc: {
        role,
        additionalRoles: additional,
        chapterId: (data?.chapterId as string | null) ?? null,
        grantedBy: data?.grantedBy as string | undefined,
        grantedAt: data?.grantedAt,
        lastChangedBy: (data?.lastChangedBy as string) ?? input.actorUid,
        updatedAt: data?.updatedAt,
        source: (data?.source as RoleWriteSource) ?? input.source,
        schemaVersion: 2,
      },
      previousEffectiveRole: effectiveRoleOf(role, additional),
      newEffectiveRole: effectiveRoleOf(role, additional),
      alreadyApplied: true,
    };
  }

  const batch = db.batch();
  const { newEffectiveRole, previous } = await addRoleChangeToBatch(db, batch, {
    uid: input.uid,
    newRole: {
      role: input.role,
      additionalRoles: input.additionalRoles,
      chapterId: input.chapterId,
    },
    actorUid: input.actorUid,
    reason: input.reason,
    capturePrevious: true,
    source: input.source,
    consentRequestId: input.consentRequestId ?? null,
    idempotencyKey: input.idempotencyKey,
  });
  await batch.commit();

  const roleDoc: RoleDoc = {
    role: input.role,
    additionalRoles: sortAdditionalRoles(input.role, input.additionalRoles ?? []),
    chapterId:
      input.chapterId !== undefined ? input.chapterId : previous.chapterId,
    grantedBy: previous.grantedBy ?? input.actorUid,
    lastChangedBy: input.actorUid,
    updatedAt: new Date(),
    source: input.source,
    schemaVersion: 2,
  };
  return {
    roleDoc,
    previousEffectiveRole: previous.role
      ? effectiveRoleOf(previous.role, previous.additionalRoles)
      : null,
    newEffectiveRole,
    alreadyApplied: false,
  };
}

export interface RemoveRoleInput {
  uid: string;
  actorUid: string;
  reason: string;
  source: RoleWriteSource;
  idempotencyKey?: string;
}

export interface RemoveRoleResult {
  previousEffectiveRole: CatalogRoleKey | null;
  alreadyApplied: boolean;
}

/**
 * Delete a roles record (Art. 2.2): the mirror returns to member_basic and
 * the history record uses action 'delete'. A missing roles doc is a no-op
 * success only when the mirror already reads member_basic; otherwise the
 * mirror is still reset so the two stores cannot disagree silently.
 */
export async function removeRole(db: Db, input: RemoveRoleInput): Promise<RemoveRoleResult> {
  validateCommon(input);
  if (await findByIdempotencyKey(db, input.idempotencyKey)) {
    return { previousEffectiveRole: null, alreadyApplied: true };
  }
  const roleRef = db.collection('roles').doc(input.uid);
  const userRef = db.collection('users').doc(input.uid);
  const [roleSnap, userSnap] = await Promise.all([roleRef.get(), userRef.get()]);
  const existing = roleSnap.data() as Record<string, unknown> | undefined;
  const previousRole = (existing?.role as CatalogRoleKey) ?? null;
  const previousAdditional = Array.isArray(existing?.additionalRoles)
    ? (existing.additionalRoles as CatalogRoleKey[])
    : [];
  const previousEffective = previousRole
    ? effectiveRoleOf(previousRole, previousAdditional)
    : null;
  const mirrorRole = userSnap.data()?.role as string | undefined;

  if (!roleSnap.exists && mirrorRole === 'member_basic') {
    return { previousEffectiveRole: null, alreadyApplied: true };
  }

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  if (roleSnap.exists) batch.delete(roleRef);
  batch.set(
    userRef,
    {
      role: 'member_basic',
      displayRole: 'member_basic',
      additionalRoles: FieldValue.delete(),
      updatedAt: now,
      roleSource: 'roles',
    },
    { merge: true },
  );
  batch.set(db.collection(ROLE_HISTORY).doc(), {
    uid: input.uid,
    roleKey: 'member_basic',
    action: 'delete',
    previousRole,
    newRole: null,
    previousAdditionalRoles: previousAdditional,
    newAdditionalRoles: [],
    previousEffectiveRole: previousEffective,
    effectiveRole: 'member_basic',
    chapterId: (existing?.chapterId as string | null) ?? null,
    grantedBy: input.actorUid,
    actorUid: input.actorUid,
    reason: input.reason.trim(),
    source: input.source,
    consentRequestId: null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
  });
  batch.set(db.collection('audit_logs').doc(), {
    action: 'role_delete',
    actorUid: input.actorUid,
    targetUserId: input.uid,
    targetRole: 'member_basic',
    details: {
      previousRole,
      previousAdditionalRoles: previousAdditional,
      reason: input.reason.trim(),
      source: input.source,
    },
    createdAt: now,
  });
  batch.set(
    db.collection('authority_refresh').doc(input.uid),
    { requestedAt: now, reason: 'role_delete' },
    { merge: true },
  );
  await batch.commit();
  return { previousEffectiveRole: previousEffective, alreadyApplied: false };
}

/**
 * Repair-only mirror recompute from an EXISTING roles doc (the
 * reconciliation job's apply path). Never creates or changes the roles
 * doc, and writes no roleHistory record: it is not a role change.
 * Returns false when no roles doc exists (nothing to repair from).
 */
export async function setMirror(db: Db, uid: string): Promise<boolean> {
  const roleSnap = await db.collection('roles').doc(uid).get();
  if (!roleSnap.exists) return false;
  const data = roleSnap.data() as Record<string, unknown>;
  const role = data.role as CatalogRoleKey;
  const additional = Array.isArray(data.additionalRoles)
    ? (data.additionalRoles as CatalogRoleKey[])
    : [];
  const effective = effectiveRoleOf(role, additional);
  const mirror: Record<string, unknown> = {
    role: effective,
    displayRole: effective,
    roleSource: 'roles',
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (additional.length > 0) mirror.additionalRoles = additional;
  else mirror.additionalRoles = FieldValue.delete();
  await db.collection('users').doc(uid).set(mirror, { merge: true });
  return true;
}
