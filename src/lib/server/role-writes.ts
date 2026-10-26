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
 * Claims absorb (RP-11 structural, decision pack item 18): the same
 * commit path also stamps the user's Firebase Auth custom claims to
 * match the new role state (see stampRoleClaims). The stamp MERGES into
 * the existing claims object - it never replaces it wholesale, so
 * unrelated claim keys (the legacy boolean claims some route arms still
 * check) survive a role change. Claims live outside Firestore, so the
 * stamp cannot join the batch: it runs immediately after the commit and
 * is fire-and-log - a claims failure never fails the role write.
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
import { supaEnabledFor } from './supa-roles-seam';
import { mirrorSeamDelete, mirrorSeamSet } from './supa-roles-route';
import {
  identityPrimaryFlagOn,
  primaryIdentityDelete,
  primaryIdentityGet,
  primaryIdentityList,
  primaryIdentitySet,
} from './supa-identity-primary';

// ---------------------------------------------------------------------------
// Custom claims stamping (RP-11 structural absorb).
//
// The claims shape this platform mints is { role, chapter_id } (the same
// shape the Firestore webhook's handleRoleWritten used to write - except
// that writer REPLACED the whole claims object; see stampRoleClaims for
// the merge rule that replaces that behaviour on this path).
// ---------------------------------------------------------------------------

/** The subset of firebase-admin Auth the claims stamp needs. */
export interface RoleClaimsAuth {
  getUser(uid: string): Promise<{ customClaims?: Record<string, unknown> }>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}

/** The role state a claims stamp must reflect. `role: null` clears the
 * role claim (the removeRole end state: no roles record remains). */
export interface RoleClaimsState {
  role: string | null;
  chapterId?: string | null;
}

async function defaultClaimsAuth(): Promise<RoleClaimsAuth | null> {
  // Lazily resolved: a static firebase-admin/auth import would drag the
  // Auth plane (and its ESM-only transitive deps) into every consumer of
  // this module, including unit tests that never stamp claims. No
  // initialized admin app (unit tests, offline tooling) means there is
  // no Auth plane to stamp, so skip silently rather than failing the
  // write. In production the caller's db came from an initialized app
  // (see src/lib/server/firebase-admin.ts), so the stamp resolves.
  try {
    const { getApps } = await import('firebase-admin/app');
    if (getApps().length === 0) return null;
    const { getAuth } = await import('firebase-admin/auth');
    return getAuth() as unknown as RoleClaimsAuth;
  } catch {
    return null;
  }
}

/**
 * Stamp a user's custom claims to match a committed role state, MERGING
 * into the existing claims object: only `role` and `chapter_id` are
 * owned by the role system; every other pre-existing key is preserved
 * verbatim. A null role / null chapter REMOVES that key from the merged
 * object (a demotion must not leave a stale chapter claim behind).
 *
 * Fire-and-log: returns true when the stamp landed, false when it was
 * skipped or failed; it never throws, so a claims failure (including
 * auth/user-not-found for accounts with no Auth record) can never fail
 * the role write that triggered it. Divergence left behind by a failed
 * stamp is exactly what role-reconciliation's claims-divergence class
 * reports.
 *
 * `auth` injection: an explicit RoleClaimsAuth is used as-is; `null`
 * disables stamping; `undefined` resolves the default admin Auth.
 */
export async function stampRoleClaims(
  uid: string,
  state: RoleClaimsState,
  auth?: RoleClaimsAuth | null,
): Promise<boolean> {
  if (auth === null) return false;
  try {
    const resolved = auth ?? (await defaultClaimsAuth());
    if (!resolved) return false;
    const record = await resolved.getUser(uid);
    const merged: Record<string, unknown> = { ...(record.customClaims ?? {}) };
    if (state.role) merged.role = state.role;
    else delete merged.role;
    if (state.chapterId) merged.chapter_id = String(state.chapterId);
    else delete merged.chapter_id;
    await resolved.setCustomUserClaims(uid, merged);
    return true;
  } catch (err) {
    console.error(
      `[role-writes] custom claims stamp failed for ${uid} (role write already committed):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

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
   * Claims stamp injection (RP-11 absorb): an explicit Auth stamps the
   * user's custom claims after the commit; `null` disables the stamp;
   * undefined uses the default admin Auth when an app is initialized.
   */
  claimsAuth?: RoleClaimsAuth | null;
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

/**
 * Supabase chokepoint mirror (roles G2, ported onto the landed
 * roles-1 seam + route helpers): after a successful Firestore
 * commit, best-effort mirror the POST-WRITE state of roles/{uid}
 * and users/{uid} by RE-READING both docs from Firestore (exact
 * state; sidesteps FieldValue.delete()/merge composition) through
 * the landed seam's mirror wrappers (mirrorSeamSet /
 * mirrorSeamDelete, which carry the Date -> ISO normalization). A
 * doc absent in Firestore is delete-mirrored. The roleHistory
 * entry written by the same operation is mirrored when the caller
 * supplies it: its createdAt is a serverTimestamp sentinel in
 * Firestore, so the mirror carries it as an ISO string (the
 * adapter stores timestamps as ISO). audit_logs and
 * authority_refresh are deliberately NOT mirrored (other
 * clusters' tables).
 *
 * Best-effort contract: engages only when useSupa('roles') is on
 * and the adapter is available (supaEnabledFor via the landed
 * seam); flag OFF returns before any re-read, so behaviour is
 * byte-identical and the adapter is never called. Any mirror
 * error is swallowed (logged) and NEVER fails or delays the
 * primary write's success path beyond the re-reads themselves:
 * the seam's mirror helpers already convert adapter errors to
 * `false`, and this wrapper's own catch covers the re-reads.
 */
export async function mirrorRoleWriteToSupa(
  db: Db,
  uid: string,
  history?: { id: string; data: Record<string, unknown> } | null,
): Promise<void> {
  try {
    if (!(await supaEnabledFor('roles'))) return;
    const [roleSnap, userSnap] = await Promise.all([
      db.collection('roles').doc(uid).get(),
      db.collection('users').doc(uid).get(),
    ]);
    if (roleSnap.exists) {
      await mirrorSeamSet('roles', uid, (roleSnap.data() ?? {}) as Record<string, unknown>);
    } else {
      await mirrorSeamDelete('roles', uid);
    }
    if (userSnap.exists) {
      await mirrorSeamSet('users', uid, (userSnap.data() ?? {}) as Record<string, unknown>);
    } else {
      await mirrorSeamDelete('users', uid);
    }
    if (history) {
      const data: Record<string, unknown> = {
        ...history.data,
        createdAt: new Date().toISOString(),
      };
      await mirrorSeamSet('roleHistory', history.id, data);
    }
  } catch (err) {
    console.error(
      `[role-writes] supa mirror failed for ${uid} (role write already committed):`,
      err instanceof Error ? err.message : err,
    );
  }
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

/* ---------------------------------------------------------------
 * WRITE PRIMACY (identity full build, design G-ROLE-1).
 *
 * Under isSupaPrimary('roles') the chokepoint inverts:
 *   1. The idempotency lookup reads the PRIMARY store (fs_roleHistory)
 *      (pin IC-07: a replay commits nothing on either store).
 *   2. The change is composed into a RECORDING batch (same composition
 *      code, same payloads — addRoleChangeToBatch / removeRole's own
 *      composition reads run against Firestore, whose copies the
 *      reverse mirrors keep transactionally fresh during transition).
 *   3. The identity ops (roles -> users -> roleHistory, in recorded
 *      order = design commit order) are applied to the adapter FIRST
 *      via the identity-primary module (sentinels resolved there).
 *      A primary failure THROWS (RoleWriteError write_failed surface
 *      is the caller's; the throw propagates) — no Firestore write
 *      has happened yet, so there is no shadow-first commit (IC-03).
 *   4. The recorded ops are then replayed into a real Firestore batch
 *      and committed as the REVERSE MIRROR, best-effort: a failure is
 *      logged, never thrown (the reconciliation job, G-ROLE-4, is the
 *      named healer). audit_logs + authority_refresh ride this batch
 *      as Firestore-native writes (they are not identity data and are
 *      never adapter-written), exactly as the design states.
 * With SUPA_PRIMARY unset, none of this engages: the real batch
 * commits first and mirrorRoleWriteToSupa mirrors as today (IC-01).
 */

interface RecordedBatchOp {
  kind: 'set' | 'delete';
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

class RecordingBatch {
  ops: RecordedBatchOp[] = [];
  set(
    ref: { path: string },
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ): this {
    this.ops.push({ kind: 'set', path: ref.path, data, merge: options?.merge === true });
    return this;
  }
  delete(ref: { path: string }): this {
    this.ops.push({ kind: 'delete', path: ref.path });
    return this;
  }
  async commit(): Promise<void> {
    throw new Error('RecordingBatch must never be committed directly');
  }
}

const PRIMARY_BATCH_COLLECTIONS = new Set(['roles', 'users', 'roleHistory']);

function splitRecordedPath(path: string): { collection: string; id: string } {
  const segments = path.split('/').filter(Boolean);
  return { collection: segments.slice(0, -1).join('/'), id: segments[segments.length - 1] };
}

async function applyRecordedPrimary(ops: RecordedBatchOp[]): Promise<void> {
  for (const op of ops) {
    const { collection, id } = splitRecordedPath(op.path);
    if (!PRIMARY_BATCH_COLLECTIONS.has(collection)) continue;
    if (op.kind === 'delete') {
      await primaryIdentityDelete('roles', collection, id);
    } else {
      await primaryIdentitySet('roles', collection, id, op.data ?? {}, { merge: true });
    }
  }
}

function replayRecordedInto(db: Db, ops: RecordedBatchOp[]): FirebaseFirestore.WriteBatch {
  const batch = db.batch();
  for (const op of ops) {
    const ref = db.doc(op.path);
    if (op.kind === 'delete') batch.delete(ref);
    else if (op.merge) batch.set(ref, op.data ?? {}, { merge: true });
    else batch.set(ref, op.data ?? {});
  }
  return batch;
}

async function commitReverseMirror(db: Db, ops: RecordedBatchOp[], uid: string): Promise<void> {
  try {
    await replayRecordedInto(db, ops).commit();
  } catch (err) {
    console.error(
      `[role-writes] Firestore reverse mirror failed for ${uid} after Supa primary commit (reconciliation is the healer):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Idempotency source under primacy: fs_roleHistory on the adapter.
 * A null list answer under a primary flag is LOUD (adapter
 * unavailable), never a silent fall-through to a Firestore check. */
async function findByIdempotencyKeyPrimary(idempotencyKey: string | undefined): Promise<boolean> {
  if (!idempotencyKey) return false;
  const rows = await primaryIdentityList('roles', ROLE_HISTORY);
  if (rows === null) {
    throw new RoleWriteError(
      'write_failed',
      500,
      'Role write failed: Supabase adapter unavailable while roles is write-primary (idempotency check)',
    );
  }
  return rows.some((r) => r.data.idempotencyKey === idempotencyKey);
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
 *
 * Claims absorb (RP-11): the same applies to the claims stamp - claims
 * live in Auth, not in this batch, so a caller composing its own commit
 * must call stampRoleClaims(uid, newState) after its commit succeeds.
 * assignRole and removeRole stamp centrally on their own commits.
 */
export async function addRoleChangeToBatch(
  db: Db,
  batch: FirebaseFirestore.WriteBatch,
  input: RoleChangeEventInput,
): Promise<{
  newEffectiveRole: CatalogRoleKey;
  previous: PreviousState;
  expiry: GrantExpiryState | null;
  historyId: string;
  historyPayload: Record<string, unknown>;
}> {
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
  const historyPayload: Record<string, unknown> = {
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
  };
  batch.set(historyRef, historyPayload);

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

  return {
    newEffectiveRole: effective,
    previous,
    expiry,
    historyId: historyRef.id as string,
    historyPayload,
  };
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

  const rolesPrimary = await identityPrimaryFlagOn('roles');
  const idempotencyHit = rolesPrimary
    ? await findByIdempotencyKeyPrimary(input.idempotencyKey)
    : await findByIdempotencyKey(db, input.idempotencyKey);
  if (idempotencyHit) {
    const current = await db.collection('roles').doc(input.uid).get();
    let data = current.data() as Record<string, unknown> | undefined;
    if (rolesPrimary) {
      // Under primacy the replay state is read from the PRIMARY store.
      const primaryCurrent = await primaryIdentityGet('roles', 'roles', input.uid);
      if (primaryCurrent?.exists) data = primaryCurrent.data;
    }
    const role = (data?.role as CatalogRoleKey) ?? input.role;
    const additional: string[] = Array.isArray(data?.additionalRoles)
      ? (data.additionalRoles as string[])
      : [];
    const catalogAdditional = sortAdditionalRoles(role, additional);
    // A replay commits nothing, but re-stamping is a merge and can only
    // heal a stamp that failed when the change originally committed.
    await stampRoleClaims(
      input.uid,
      { role, chapterId: (data?.chapterId as string | null) ?? null },
      input.claimsAuth,
    );
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

  const recording = rolesPrimary ? new RecordingBatch() : null;
  const batch = recording
    ? (recording as unknown as FirebaseFirestore.WriteBatch)
    : db.batch();
  const { newEffectiveRole, previous, expiry, historyId, historyPayload } = await addRoleChangeToBatch(db, batch, {
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
  if (recording) {
    // PRIMACY (G-ROLE-1): adapter writes first (roles -> users ->
    // roleHistory, recorded order), loud on failure; the Firestore
    // batch then commits as the best-effort reverse mirror (audit +
    // authority_refresh ride it as Firestore-native writes).
    await applyRecordedPrimary(recording.ops);
    await commitReverseMirror(db, recording.ops, input.uid);
    void historyId;
    void historyPayload;
  } else {
    await batch.commit();
    // Supabase chokepoint mirror (best-effort, flag-gated): mirror the
    // committed roles/users state + this history entry. Never throws.
    await mirrorRoleWriteToSupa(db, input.uid, historyId ? { id: historyId, data: historyPayload } : null);
  }
  // Read-Burn A (§2.5 W1): central identity-cache bust for every
  // assignRole caller, immediately after the commit succeeds.
  bustIdentity(input.uid);
  // Claims absorb (RP-11): stamp the Auth claims to the just-committed
  // role state, merged into the existing claims object. Fire-and-log -
  // a claims failure never fails this role write.
  await stampRoleClaims(
    input.uid,
    {
      role: input.role,
      chapterId:
        input.chapterId !== undefined ? input.chapterId : previous.chapterId,
    },
    input.claimsAuth,
  );

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
  /** Claims stamp injection; see AssignRoleInput.claimsAuth. */
  claimsAuth?: RoleClaimsAuth | null;
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
  const rolesPrimary = await identityPrimaryFlagOn('roles');
  const idempotencyHit = rolesPrimary
    ? await findByIdempotencyKeyPrimary(input.idempotencyKey)
    : await findByIdempotencyKey(db, input.idempotencyKey);
  if (idempotencyHit) {
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
  const recording = rolesPrimary ? new RecordingBatch() : null;
  const batch = recording
    ? (recording as unknown as FirebaseFirestore.WriteBatch)
    : db.batch();
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
  const removeHistoryRef = db.collection(ROLE_HISTORY).doc();
  const removeHistoryPayload: Record<string, unknown> = {
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
  };
  batch.set(removeHistoryRef, removeHistoryPayload);
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
  if (recording) {
    // PRIMACY (G-ROLE-1, IC-05): fs_roles row deleted first, users
    // mirror + roleHistory applied to the adapter, then the Firestore
    // batch commits as the best-effort reverse mirror.
    await applyRecordedPrimary(recording.ops);
    await commitReverseMirror(db, recording.ops, input.uid);
  } else {
    await batch.commit();
    // Supabase chokepoint mirror (best-effort, flag-gated): the roles
    // doc is gone, so it delete-mirrors; users + history set-mirror.
    // Never throws.
    await mirrorRoleWriteToSupa(db, input.uid, { id: removeHistoryRef.id as string, data: removeHistoryPayload });
  }
  // Read-Burn A (§2.5 W2): central identity-cache bust for removeRole.
  bustIdentity(input.uid);
  // Claims absorb (RP-11): the roles record is gone, so the role claim
  // is cleared (merged delete - unrelated claims survive); the chapter
  // claim follows the users doc, whose chapterId removeRole leaves
  // untouched. Fire-and-log, exactly as in assignRole.
  await stampRoleClaims(
    input.uid,
    {
      role: null,
      chapterId: (userSnap.data()?.chapterId as string | null) ?? null,
    },
    input.claimsAuth,
  );
  return { previousEffectiveRole: previousEffective, alreadyApplied: false };
}

/**
 * Repair-only mirror recompute from an EXISTING roles doc (the
 * reconciliation job's apply path). Never creates or changes the roles
 * doc, and writes no roleHistory record: it is not a role change.
 * Returns false when no roles doc exists (nothing to repair from).
 */
export async function setMirror(db: Db, uid: string): Promise<boolean> {
  const rolesPrimary = await identityPrimaryFlagOn('roles');
  let data: Record<string, unknown> | undefined;
  if (rolesPrimary) {
    // Under primacy the roles doc is read from the PRIMARY store.
    const primaryRole = await primaryIdentityGet('roles', 'roles', uid);
    if (primaryRole === null) {
      throw new RoleWriteError(
        'write_failed',
        500,
        'Role write failed: Supabase adapter unavailable while roles is write-primary (setMirror)',
      );
    }
    if (!primaryRole.exists) return false;
    data = primaryRole.data;
  } else {
    const roleSnap = await db.collection('roles').doc(uid).get();
    if (!roleSnap.exists) return false;
    data = roleSnap.data() as Record<string, unknown>;
  }
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
  if (rolesPrimary) {
    // PRIMACY (G-ROLE-1, U-03): the Supa users row is the primary
    // write (this GAINS the mirror U-03 lacked today, in reverse);
    // the Firestore set below becomes the best-effort reverse mirror.
    await primaryIdentitySet('roles', 'users', uid, mirror, { merge: true });
    try {
      await db.collection('users').doc(uid).set(mirror, { merge: true });
    } catch (err) {
      console.error(
        `[role-writes] setMirror Firestore reverse mirror failed for ${uid} after Supa primary commit:`,
        err instanceof Error ? err.message : err,
      );
    }
    bustIdentity(uid);
    return true;
  }
  await db.collection('users').doc(uid).set(mirror, { merge: true });
  // Read-Burn A (§2.5 W3): the mirror write changes the users
  // identity projection, so the cached bundle for this uid is stale.
  bustIdentity(uid);
  return true;
}
