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

import { FieldValue, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import {
  type CatalogRoleKey,
  isCatalogRoleKey,
  normalizeRoleSlug,
  scopeOf,
  rankOf,
  effectiveRoleOf,
  sortAdditionalRoles,
} from '../role-catalog';
import { isCustomRoleSlug as isLawfulCustomRoleSlug } from '../custom-roles';
import { isFounderUid } from '@/config/founder';
import { bustIdentity } from './identity-cache';

export type RoleWriteSource =
  | 'admin_ui'
  | 'authority_inspector'
  | 'superadmin_page'
  | 'warning_demotion'
  | 'hierarchy'
  | 'self_service_signup'
  | 'reconciliation_repair'
  | 'expiry_sweep'
  | 'migration';

export type RoleWriteErrorCode =
  | 'unknown_role'
  | 'derived_role_not_assignable'
  | 'reserved_role'
  | 'invalid_reason'
  | 'chapter_required'
  | 'actor_not_authorized'
  | 'user_not_found'
  | 'write_failed'
  // Custom Roles Fix Program (contracts.md section 3.2):
  | 'custom_role_definition_invalid'
  | 'custom_role_inactive'
  | 'custom_role_chapter_mismatch'
  | 'custom_role_reserved_permission'
  | 'invalid_expiry';

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

export type ExpiryAlertStage = 'none' | 't30_sent' | 't7_sent' | 'expired_sent';

export interface RoleDoc {
  role: CatalogRoleKey;
  /**
   * Stored form (contracts.md section 2.1): catalog partition in
   * sortAdditionalRoles order, then custom_ slugs deduped and ascending.
   * Element type is string: custom roles live ONLY here, never in `role`.
   */
  additionalRoles: string[];
  chapterId: string | null;
  grantedBy?: string;
  grantedAt?: unknown;
  lastChangedBy: string;
  updatedAt: unknown;
  source: RoleWriteSource;
  schemaVersion: 2;
  /**
   * Grant expiry fields (contracts 2.2; expiry-core). Optional; only a
   * custom-role grant carrying an expiry ever sets them. At most ONE
   * pending expiring grant per doc (the latest stamp wins).
   */
  expiresAt?: Timestamp | Date | null;
  expiresRoleKey?: string | null;
  priorRole?: CatalogRoleKey | null;
  priorAdditionalRoles?: string[];
  expiryAlertStage?: ExpiryAlertStage;
}

/** The post-write pending-expiry state of a roles doc (null = none). */
export interface GrantExpiryState {
  expiresAt: unknown;
  expiresRoleKey: string;
  priorRole: CatalogRoleKey | null;
  priorAdditionalRoles: string[];
  expiryAlertStage: ExpiryAlertStage;
}

export interface AssignRoleInput {
  uid: string;
  role: CatalogRoleKey;
  additionalRoles?: string[];
  chapterId?: string | null;
  actorUid: string;
  reason: string;
  source: RoleWriteSource;
  consentRequestId?: string | null;
  idempotencyKey?: string;
  /**
   * Grant expiry (contracts 2.2): a Date/Timestamp stamps an expiry for
   * expiresRoleKey; null explicitly clears a pending expiry; undefined
   * leaves any pending expiry untouched (preserved while its slug is
   * still held, cleared when a write removes the slug).
   */
  expiresAt?: Date | Timestamp | null;
  expiresRoleKey?: string;
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

// ---------------------------------------------------------------------------
// Custom roles (Custom Roles Fix Program; contracts.md sections 1-3).
//
// A custom role is a `custom_`-prefixed slug backed by a roleDefinitions
// doc with isCustom === true. It is assignable ONLY as an additionalRoles
// entry (contracts K2): the primary slot always holds a catalog key.
// role-catalog.ts is deliberately NOT involved beyond isCatalogRoleKey /
// normalizeRoleSlug: sortAdditionalRoles silently DROPS non-catalog
// strings and effectiveRoleOf THROWS on them, so every array is
// PARTITIONED here before any catalog helper sees it.
// ---------------------------------------------------------------------------

const CUSTOM_ROLE_PREFIX = 'custom_';

/** Reserved Powers a custom definition may never carry (contracts 1.5). */
const RESERVED_PERMISSION_KEYS_FOR_CUSTOM: readonly string[] = [
  'canManagePermissions',
  'canManageRoles',
];

/**
 * Loose PARTITION test (assign-path): normalises first, so a malformed
 * custom-ish token is still collected as a candidate and refused by
 * the async definition check (unknown_role) instead of being silently
 * dropped by the partition. NOT the lawful-grammar test: expiry
 * validation uses isLawfulCustomRoleSlug (the strict core grammar in
 * src/lib/custom-roles.ts) instead.
 */
function isCustomRoleSlug(key: string): boolean {
  return normalizeRoleSlug(key).startsWith(CUSTOM_ROLE_PREFIX);
}

type ClassifiedAdditional =
  | { kind: 'catalog'; key: CatalogRoleKey }
  | { kind: 'custom'; slug: string };

/**
 * Sync classification of one additionalRoles entry. Catalog keys are
 * validated inline (derived check included); custom candidates are
 * collected for the async definition check in addRoleChangeToBatch;
 * anything else is unknown_role, exactly as before this program. Junk
 * slugs (pakistan-president, super-admin, ...) have no custom_ prefix
 * and no catalog key, so they die here unchanged (invariant 10).
 */
function classifyAdditional(key: string): ClassifiedAdditional {
  if (isCatalogRoleKey(key)) {
    validateRoleKey(key);
    return { kind: 'catalog', key };
  }
  if (isCustomRoleSlug(key)) return { kind: 'custom', slug: key };
  throw new RoleWriteError('unknown_role', 400, `Role "${key}" is not in the catalog`);
}

interface AdditionalPartition {
  catalog: CatalogRoleKey[];
  custom: string[];
  /** catalog (sortAdditionalRoles order) ++ custom (deduped, slug-ascending). */
  stored: string[];
}

function partitionAdditionalRoles(
  primary: CatalogRoleKey,
  raw: readonly string[],
): AdditionalPartition {
  const catalog = sortAdditionalRoles(primary, raw);
  const customSet = new Set<string>();
  for (const key of raw) {
    if (!isCatalogRoleKey(key) && isCustomRoleSlug(key)) customSet.add(key);
  }
  const custom = [...customSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { catalog, custom, stored: [...catalog, ...custom] };
}

/**
 * The async custom-grant check (contracts 3.2, validation order per the
 * assign-path plan section 2 step 6). One roleDefinitions read per
 * candidate. The definition read is done directly here rather than
 * through data-model's server adapter (src/lib/server/custom-role-
 * registry.ts): the adapter returns CustomRoleDefinition | null, which
 * cannot distinguish "no doc" (unknown_role) from "doc fails the
 * four-part test" (custom_role_definition_invalid); this function is the
 * single read site, so the merge can re-point it in one place.
 *
 * The reserved-key ceiling reads the definition's stored `permissions`
 * field ONLY (contracts K1): `permissionKeys` is a request-body field
 * name and is never stored or read here.
 */
async function validateCustomAdditional(
  db: Db,
  slug: string,
  resolvedChapterId: string | null,
): Promise<void> {
  const snap = await db.collection('roleDefinitions').doc(slug).get();
  if (!snap.exists) {
    throw new RoleWriteError(
      'unknown_role',
      400,
      `Custom role "${slug}" has no definition`,
    );
  }
  const def = (snap.data() ?? {}) as Record<string, unknown>;
  // Spec section 10 four-part test: isCustom, catalog parent, chapter.
  if (def.isCustom !== true) {
    throw new RoleWriteError(
      'custom_role_definition_invalid',
      400,
      `Custom role "${slug}" definition is not marked isCustom`,
    );
  }
  if (!isCatalogRoleKey(def.parentRoleKey)) {
    throw new RoleWriteError(
      'custom_role_definition_invalid',
      400,
      `Custom role "${slug}" definition has no catalog parentRoleKey`,
    );
  }
  if (typeof def.chapterId !== 'string' || def.chapterId === '') {
    throw new RoleWriteError(
      'custom_role_definition_invalid',
      400,
      `Custom role "${slug}" definition has no chapterId`,
    );
  }
  if (def.isActive === false) {
    throw new RoleWriteError(
      'custom_role_inactive',
      400,
      `Custom role "${slug}" is retired (isActive=false) and cannot be assigned`,
    );
  }
  // Invariant 3, third enforcement point (security review SEC-03): even a
  // hand-written definition that predates the create-side filter fails
  // closed here. Checked BEFORE the chapter match: a poisoned definition
  // is refused no matter who it is aimed at.
  const permissions = Array.isArray(def.permissions) ? (def.permissions as unknown[]) : [];
  const reserved = RESERVED_PERMISSION_KEYS_FOR_CUSTOM.find((k) => permissions.includes(k));
  if (reserved) {
    throw new RoleWriteError(
      'custom_role_reserved_permission',
      400,
      `Custom role "${slug}" definition carries the Reserved Power ${reserved}; assignment refused until the definition is fixed`,
    );
  }
  // SEC-07: catalog chapter enforcement keys off catalog scope, which a
  // custom role does not have, so the match is enforced explicitly
  // against the holder's RESOLVED chapterId.
  if (!resolvedChapterId) {
    throw new RoleWriteError(
      'chapter_required',
      400,
      `Custom role "${slug}" is chapter-scoped and the target has no chapterId`,
    );
  }
  if (def.chapterId !== resolvedChapterId) {
    throw new RoleWriteError(
      'custom_role_chapter_mismatch',
      400,
      `Custom role "${slug}" belongs to chapter ${def.chapterId}, not ${resolvedChapterId}`,
    );
  }
}

/**
 * The founder gate: founder_patron, and any R5/R4 key, may only be granted
 * by the Founder. Enforced here so no caller can bypass it.
 *
 * ONE narrow exemption (expiry-core H8, SEC-08 point 2): the expiry
 * sweep's dedicated system actor - actorUid 'system' AND source
 * 'expiry_sweep', both markers required - skips the R5/R4 actor gate for
 * its materialisation calls, because a lawful grant-time snapshot can
 * hold an R4/R5 prior primary and the sweep must be able to restore it.
 * The exemption is unreachable through the public write route (its source
 * mapping never yields 'expiry_sweep' and the actor comes from the
 * authenticated profile, never the body); only server modules importing
 * this file directly can present both markers. The founder_patron TARGET
 * check below has NO exemption: a tampered snapshot claiming
 * founder_patron for anyone else still throws reserved_role.
 */
function validateActorForRole(
  actorUid: string,
  role: CatalogRoleKey,
  targetUid: string,
  source?: RoleWriteSource,
): void {
  const isExpirySweep = actorUid === 'system' && source === 'expiry_sweep';
  const rank = rankOf(role);
  if ((rank === 'R5' || rank === 'R4') && !isFounderUid(actorUid) && !isExpirySweep) {
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

/** Millis for an expiry instant in any shape the store boundary admits. */
function expiryInstantMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  if (value && typeof value === 'object') {
    const v = value as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
  }
  return NaN;
}

/**
 * Expiry validation (contracts 2.2). Called ONLY from addRoleChangeToBatch,
 * after the write's resulting stored additionalRoles are known, and never
 * on the idempotency early-return path (a replay does not re-validate).
 * Any failure is `invalid_expiry` (400) and nothing is written.
 */
function validateExpiryInput(
  input: { expiresAt?: Date | Timestamp | null; expiresRoleKey?: string },
  resultingAdditionalRoles: readonly string[],
  nowMs: number,
): void {
  const { expiresAt, expiresRoleKey } = input;
  if (expiresAt === undefined && expiresRoleKey === undefined) return;
  // Explicit clear is always valid; expiresRoleKey may accompany it (the
  // sweep sends both) or not (clear whatever is pending).
  if (expiresAt === null) return;
  if (expiresAt === undefined || expiresRoleKey === undefined) {
    throw new RoleWriteError(
      'invalid_expiry',
      400,
      'expiresAt and expiresRoleKey must be provided together',
    );
  }
  if (!isLawfulCustomRoleSlug(expiresRoleKey)) {
    throw new RoleWriteError(
      'invalid_expiry',
      400,
      `expiresRoleKey "${expiresRoleKey}" is not a custom role slug`,
    );
  }
  if (!resultingAdditionalRoles.includes(expiresRoleKey)) {
    throw new RoleWriteError(
      'invalid_expiry',
      400,
      `expiresRoleKey "${expiresRoleKey}" is not among the additional roles written by this grant`,
    );
  }
  const ms = expiryInstantMs(expiresAt);
  if (!Number.isFinite(ms) || ms <= nowMs) {
    throw new RoleWriteError(
      'invalid_expiry',
      400,
      'expiresAt must be a valid instant strictly in the future',
    );
  }
}

interface PreviousState {
  role: CatalogRoleKey | null;
  /** Raw stored additionalRoles, verbatim (may hold custom_ slugs). */
  additionalRoles: string[];
  /** Catalog partition of additionalRoles; the only form effectiveRoleOf may see. */
  catalogAdditionalRoles: CatalogRoleKey[];
  chapterId: string | null;
  grantedBy?: string;
  grantedAt?: unknown;
  existed: boolean;
  /** Raw pending-expiry reads from the stored doc (contracts 2.2). Never
   * passed through any catalog helper: the snapshot must be the stored
   * bytes or the sweep's restore cannot be exact. */
  expiresAt?: unknown;
  expiresRoleKey?: string | null;
  priorRole?: CatalogRoleKey | null;
  priorAdditionalRoles?: string[];
  expiryAlertStage?: string;
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
    additionalRoles?: string[];
    chapterId?: string | null;
  };
  actorUid: string;
  reason: string;
  capturePrevious: true;
  source: RoleWriteSource;
  consentRequestId?: string | null;
  idempotencyKey?: string;
  /** Grant expiry passthrough (contracts 2.2); see AssignRoleInput. */
  expiresAt?: Date | Timestamp | null;
  expiresRoleKey?: string;
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
 *
 * Read-Burn A (plan §2.5 W4): this helper composes into a CALLER-owned
 * batch and cannot bust the identity cache (nothing is committed yet).
 * Any caller must call bustIdentity(uid) after its own batch.commit()
 * succeeds. (No external caller exists today; assignRole busts
 * centrally at W1.)
 */
export async function addRoleChangeToBatch(
  db: Db,
  batch: FirebaseFirestore.WriteBatch,
  input: RoleChangeEventInput,
): Promise<{ newEffectiveRole: CatalogRoleKey; previous: PreviousState; expiry: GrantExpiryState | null }> {
  validateCommon(input);
  validateRoleKey(input.newRole.role);
  const classified = (input.newRole.additionalRoles ?? []).map(classifyAdditional);
  const customSlugs = classified
    .filter((c): c is { kind: 'custom'; slug: string } => c.kind === 'custom')
    .map((c) => c.slug);
  validateActorForRole(input.actorUid, input.newRole.role, input.uid, input.source);

  const roleRef = db.collection('roles').doc(input.uid);
  const userRef = db.collection('users').doc(input.uid);
  const [roleSnap, userSnap] = await Promise.all([roleRef.get(), userRef.get()]);
  const existing = roleSnap.exists ? (roleSnap.data() as Record<string, unknown>) : null;
  const previousRole = (existing?.role as CatalogRoleKey) ?? null;
  const previousAdditionalRaw: string[] = Array.isArray(existing?.additionalRoles)
    ? (existing.additionalRoles as string[])
    : [];
  const previous: PreviousState = {
    role: previousRole,
    additionalRoles: previousAdditionalRaw,
    catalogAdditionalRoles: previousRole
      ? sortAdditionalRoles(previousRole, previousAdditionalRaw)
      : [],
    chapterId: (existing?.chapterId as string | null) ?? (userSnap.data()?.chapterId as string | null) ?? null,
    grantedBy: existing?.grantedBy as string | undefined,
    grantedAt: existing?.grantedAt,
    existed: roleSnap.exists,
    expiresAt: existing?.expiresAt,
    expiresRoleKey: (existing?.expiresRoleKey as string | null) ?? null,
    priorRole: (existing?.priorRole as CatalogRoleKey | null) ?? null,
    priorAdditionalRoles: Array.isArray(existing?.priorAdditionalRoles)
      ? (existing.priorAdditionalRoles as string[])
      : undefined,
    expiryAlertStage: existing?.expiryAlertStage as string | undefined,
  };

  const partition = partitionAdditionalRoles(
    input.newRole.role,
    input.newRole.additionalRoles ?? [],
  );
  const additionalRoles = partition.stored;
  const chapterId =
    input.newRole.chapterId !== undefined ? input.newRole.chapterId : previous.chapterId;
  if (scopeOf(input.newRole.role) === 'chapter' && !chapterId) {
    throw new RoleWriteError(
      'chapter_required',
      400,
      `Role ${input.newRole.role} is chapter-scoped and requires a chapterId`,
    );
  }
  // Async custom-grant validation, in input order, against the RESOLVED
  // chapter (input, else previous roles doc, else users doc).
  for (const slug of customSlugs) {
    await validateCustomAdditional(db, slug, chapterId ?? null);
  }
  // Expiry validation runs against the RESULTING stored additionalRoles
  // (contracts 2.2) and only here: assignRole's idempotency early-return
  // must stay validation-free so a replay never re-validates.
  const nowMs = input.timestamp instanceof Date ? input.timestamp.getTime() : Date.now();
  validateExpiryInput(input, additionalRoles, nowMs);
  const effective = effectiveRoleOf(input.newRole.role, partition.catalog);
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

  // --- Grant expiry composition (contracts 2.2; expiry-core H4) --------
  // The roles doc is written with merge:true, so an ABSENT field is
  // preserved and only an explicit FieldValue.delete() clears one.
  let expiry: GrantExpiryState | null = null;
  const historyExpiry: Record<string, unknown> = {};
  const previousHasPendingExpiry = previous.expiresAt != null && previous.expiresRoleKey != null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    // (a) STAMP. Capture is server-side, from the previous-state read
    // above - never from caller-supplied prior state (probation capture
    // pattern; SEC-08 point 4).
    const slug = input.expiresRoleKey as string;
    let priorRoleSnap: CatalogRoleKey | null;
    let priorAdditionalSnap: string[];
    if (previousHasPendingExpiry && previous.expiresRoleKey === slug) {
      // X11 chain inheritance: a superseding re-grant of the SAME slug
      // inherits the chain's original snapshot. Snapshotting the current
      // stored arrays here would capture the slug itself (held only
      // under the old expiry) and the sweep would restore it forever.
      priorRoleSnap = previous.priorRole ?? previous.role;
      priorAdditionalSnap =
        previous.priorAdditionalRoles ?? [...previous.additionalRoles];
    } else {
      priorRoleSnap = previous.role;
      priorAdditionalSnap = [...previous.additionalRoles];
    }
    roleDoc.expiresAt = input.expiresAt;
    roleDoc.expiresRoleKey = slug;
    roleDoc.priorRole = priorRoleSnap;
    roleDoc.priorAdditionalRoles = priorAdditionalSnap;
    roleDoc.expiryAlertStage = 'none';
    historyExpiry.expiresAt = input.expiresAt;
    historyExpiry.expiresRoleKey = slug;
    if (previousHasPendingExpiry) {
      historyExpiry.supersededExpiresAt = previous.expiresAt;
      historyExpiry.supersededExpiresRoleKey = previous.expiresRoleKey;
    }
    expiry = {
      expiresAt: input.expiresAt,
      expiresRoleKey: slug,
      priorRole: priorRoleSnap,
      priorAdditionalRoles: priorAdditionalSnap,
      expiryAlertStage: 'none',
    };
  } else if (input.expiresAt === null) {
    // (b) CLEAR: explicit null retires any pending expiry in this batch.
    roleDoc.expiresAt = FieldValue.delete();
    roleDoc.expiresRoleKey = FieldValue.delete();
    roleDoc.priorRole = FieldValue.delete();
    roleDoc.priorAdditionalRoles = FieldValue.delete();
    roleDoc.expiryAlertStage = FieldValue.delete();
  } else if (previousHasPendingExpiry) {
    // (c) NOT CARRIED: the expiry lives and dies with the grant it was
    // stamped on. Still held -> write nothing (merge preserves the five
    // fields byte-identical). Removed by this write -> clear them all.
    if ((additionalRoles as string[]).includes(previous.expiresRoleKey as string)) {
      expiry = {
        expiresAt: previous.expiresAt,
        expiresRoleKey: previous.expiresRoleKey as string,
        priorRole: previous.priorRole ?? null,
        priorAdditionalRoles: previous.priorAdditionalRoles ?? [],
        expiryAlertStage: (previous.expiryAlertStage as ExpiryAlertStage | undefined) ?? 'none',
      };
    } else {
      roleDoc.expiresAt = FieldValue.delete();
      roleDoc.expiresRoleKey = FieldValue.delete();
      roleDoc.priorRole = FieldValue.delete();
      roleDoc.priorAdditionalRoles = FieldValue.delete();
      roleDoc.expiryAlertStage = FieldValue.delete();
    }
  }
  // Named for the audit details below (assign-path): a stamp that
  // replaced a pending expiry records what it superseded.
  const supersededExpiry =
    input.expiresAt !== undefined && input.expiresAt !== null && previous.expiresRoleKey
      ? {
          supersededExpiresAt: previous.expiresAt ?? null,
          supersededExpiresRoleKey: previous.expiresRoleKey,
        }
      : null;
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
      ? effectiveRoleOf(previous.role, previous.catalogAdditionalRoles)
      : null,
    effectiveRole: effective,
    chapterId: chapterId ?? null,
    grantedBy: input.actorUid,
    actorUid: input.actorUid,
    reason: input.reason.trim(),
    source: input.source,
    consentRequestId: input.consentRequestId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    // Grant expiry stamps ride as TOP-LEVEL history fields (contracts
    // 2.2; history entries are flat - there is no details sub-object).
    ...historyExpiry,
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
      customRoles: partition.custom,
      reason: input.reason.trim(),
      source: input.source,
      consentRequestId: input.consentRequestId ?? null,
      ...(supersededExpiry ?? {}),
    },
    createdAt: now,
  });

  batch.set(
    db.collection('authority_refresh').doc(input.uid),
    { requestedAt: now, reason: 'role_change' },
    { merge: true },
  );

  return { newEffectiveRole: effective, previous, expiry };
}

/**
 * Assign (grant or change) a role: one transaction composing roles +
 * mirror + roleHistory + audit + authority_refresh. Idempotent on
 * idempotencyKey. Throws RoleWriteError; never swallows.
 */
export async function assignRole(db: Db, input: AssignRoleInput): Promise<AssignRoleResult> {
  validateCommon(input);
  validateRoleKey(input.role);
  // Sync classification only: catalog keys validated, custom candidates
  // deferred to addRoleChangeToBatch (their definition check needs a DB
  // read and must NOT run on an idempotent replay - contracts 3.2).
  for (const extra of input.additionalRoles ?? []) classifyAdditional(extra);
  validateActorForRole(input.actorUid, input.role, input.uid, input.source);

  if (await findByIdempotencyKey(db, input.idempotencyKey)) {
    const current = await db.collection('roles').doc(input.uid).get();
    const data = current.data() as Record<string, unknown> | undefined;
    const role = (data?.role as CatalogRoleKey) ?? input.role;
    const additional: string[] = Array.isArray(data?.additionalRoles)
      ? (data.additionalRoles as string[])
      : [];
    const catalogAdditional = sortAdditionalRoles(role, additional);
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
        // A replay performs NO expiry validation (contracts 3.2); it
        // only echoes the stored pending-expiry state.
        expiresAt: data?.expiresAt as RoleDoc['expiresAt'],
        expiresRoleKey: (data?.expiresRoleKey as string | null) ?? undefined,
        priorRole: (data?.priorRole as CatalogRoleKey | null) ?? undefined,
        priorAdditionalRoles: Array.isArray(data?.priorAdditionalRoles)
          ? (data.priorAdditionalRoles as string[])
          : undefined,
        expiryAlertStage: data?.expiryAlertStage as ExpiryAlertStage | undefined,
      },
      previousEffectiveRole: effectiveRoleOf(role, catalogAdditional),
      newEffectiveRole: effectiveRoleOf(role, catalogAdditional),
      alreadyApplied: true,
    };
  }

  const batch = db.batch();
  const { newEffectiveRole, previous, expiry } = await addRoleChangeToBatch(db, batch, {
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
    expiresAt: input.expiresAt,
    expiresRoleKey: input.expiresRoleKey,
  });
  await batch.commit();
  // Read-Burn A (§2.5 W1): central identity-cache bust for every
  // assignRole caller, immediately after the commit succeeds.
  bustIdentity(input.uid);

  const partition = partitionAdditionalRoles(input.role, input.additionalRoles ?? []);
  const roleDoc: RoleDoc = {
    role: input.role,
    additionalRoles: partition.stored,
    chapterId:
      input.chapterId !== undefined ? input.chapterId : previous.chapterId,
    grantedBy: previous.grantedBy ?? input.actorUid,
    lastChangedBy: input.actorUid,
    updatedAt: new Date(),
    source: input.source,
    schemaVersion: 2,
    ...(expiry
      ? {
          expiresAt: expiry.expiresAt as RoleDoc['expiresAt'],
          expiresRoleKey: expiry.expiresRoleKey,
          priorRole: expiry.priorRole,
          priorAdditionalRoles: expiry.priorAdditionalRoles,
          expiryAlertStage: expiry.expiryAlertStage,
        }
      : {}),
  };
  return {
    roleDoc,
    previousEffectiveRole: previous.role
      ? effectiveRoleOf(previous.role, previous.catalogAdditionalRoles)
      : null,
    newEffectiveRole,
    alreadyApplied: false,
  };
}

/**
 * Pre-gate validation for assign (founder-consent program, spec-auditor
 * defect 2026-10-24): runs EVERY validation assignRole +
 * addRoleChangeToBatch will run — validateCommon, validateRoleKey,
 * additional-role classification, validateActorForRole, the
 * chapter_required check against the RESOLVED chapter (request, else
 * stored roles doc, else users mirror), async custom-definition
 * validation, and validateExpiryInput against the RESULTING stored
 * additionalRoles — without writing anything and without the
 * idempotency lookup (a replay is not a new gated act, and the gate
 * must never mint a founder-act consent for a request this function
 * would reject). Routes that write a consent record inside their gate
 * (roles/write) call this BEFORE the gate for founder actors, so an
 * invalid founder request returns the exact RoleWriteError assignRole
 * would have thrown and the gate is never reached. Read-only: two doc
 * reads (roles + users) plus one roleDefinitions read per custom slug,
 * mirroring addRoleChangeToBatch's own reads.
 */
export async function validateAssignRoleInput(db: Db, input: AssignRoleInput): Promise<void> {
  validateCommon(input);
  validateRoleKey(input.role);
  const classified = (input.additionalRoles ?? []).map(classifyAdditional);
  validateActorForRole(input.actorUid, input.role, input.uid, input.source);

  const roleRef = db.collection('roles').doc(input.uid);
  const userRef = db.collection('users').doc(input.uid);
  const [roleSnap, userSnap] = await Promise.all([roleRef.get(), userRef.get()]);
  const existing = roleSnap.exists ? (roleSnap.data() as Record<string, unknown>) : null;
  const previousChapterId =
    (existing?.chapterId as string | null) ?? (userSnap.data()?.chapterId as string | null) ?? null;
  const chapterId = input.chapterId !== undefined ? input.chapterId : previousChapterId;
  if (scopeOf(input.role) === 'chapter' && !chapterId) {
    throw new RoleWriteError(
      'chapter_required',
      400,
      `Role ${input.role} is chapter-scoped and requires a chapterId`,
    );
  }
  const partition = partitionAdditionalRoles(input.role, input.additionalRoles ?? []);
  for (const entry of classified) {
    if (entry.kind === 'custom') {
      await validateCustomAdditional(db, entry.slug, chapterId ?? null);
    }
  }
  validateExpiryInput(input, partition.stored, Date.now());
}

/**
 * Pre-gate validation for remove: removeRole runs validateCommon only,
 * so that is the whole set. See validateAssignRoleInput for why a
 * gated route calls this before its consent gate for founder actors.
 */
export function validateRemoveRoleInput(input: RemoveRoleInput): void {
  validateCommon(input);
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
  const previousAdditional: string[] = Array.isArray(existing?.additionalRoles)
    ? (existing.additionalRoles as string[])
    : [];
  const previousEffective = previousRole
    ? effectiveRoleOf(previousRole, sortAdditionalRoles(previousRole, previousAdditional))
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
  // Read-Burn A (§2.5 W2): central identity-cache bust for removeRole.
  bustIdentity(input.uid);
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
  const additional: string[] = Array.isArray(data.additionalRoles)
    ? (data.additionalRoles as string[])
    : [];
  const effective = effectiveRoleOf(role, sortAdditionalRoles(role, additional));
  const mirror: Record<string, unknown> = {
    role: effective,
    displayRole: effective,
    roleSource: 'roles',
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (additional.length > 0) mirror.additionalRoles = additional;
  else mirror.additionalRoles = FieldValue.delete();
  await db.collection('users').doc(uid).set(mirror, { merge: true });
  // Read-Burn A (§2.5 W3): the mirror write changes the users
  // identity projection, so the cached bundle for this uid is stale.
  bustIdentity(uid);
  return true;
}
