import { getDb, admin } from '@/lib/server/firebase-admin';
import { hasPermissionForRole, type PermissionKey } from '@/config/permissions.config';
import { normalizeUserRole, type UserRole } from '@/lib/roles';
import { normalizeRoleSlug } from '@/lib/unified-roles';
import { LEGACY_TO_CATALOG, LEGACY_RESOLUTION_NARROWED, isCustomRoleSlug } from '@/lib/role-catalog';

// Note: normalizeUserRole() is idempotent for canonical tokens (575d5bb):
// an already-canonical token normalizes to itself, so the
// normalizeRoleSlug-then-normalizeUserRole chain is safe to apply to both
// raw stored tokens and canonical tokens (e.g. a canonical AuthContext.role
// passed back into hasServerPermission, or a canonical token written by the
// new canonical task-form dropdowns).

/**
 * Reserved Powers a custom role may NEVER hold (Custom Roles contracts
 * section 1.5). Enforced at resolution time here (security review
 * SEC-03 point 4) in addition to the create / editor-save / assignment
 * points owned by other items, so a stale or hand-written definition
 * cannot mint them either. Custom roles only: catalog roles keep
 * today's behaviour exactly.
 */
const RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES: readonly PermissionKey[] = [
    'canManagePermissions',
    'canManageRoles',
];

/**
 * Validates if a user role has the required granular permission by checking 
 * the dynamic Firestore `permissions` collection first, and falling back to the local config.
 */
export async function hasServerPermission(role: UserRole | string | null | undefined, permission: PermissionKey): Promise<boolean> {
    if (!role) return false;

    // Spec step 03: callers may pass a raw stored token or an already
    // canonical token; both converge here. normalizeRoleSlug is idempotent,
    // and normalizeUserRole passes canonical tokens through (575d5bb), so
    // normalizing twice is safe.
    const legacySlug = normalizeRoleSlug(role);
    const canonicalSlug = normalizeUserRole(legacySlug);
    // Custom-role subjects (contracts section 4.4, plan R2/R4): a token
    // in the custom_ namespace is its own FIRST candidate and the
    // member_basic floor never precedes it — that ordering is the whole
    // shadowing fix (SEC-11): the custom definition's `permissions`
    // array is consulted before any floor doc and is authoritative, and
    // the floor only fills the fallthrough tiers. Reserved Powers
    // return false before any doc lookup, so neither a definition array
    // nor a permissions/{custom} boolean can make them true (SEC-03.4).
    const customSubject = isCustomRoleSlug(legacySlug);
    if (customSubject && RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES.includes(permission)) {
        return false;
    }
    const slugsToTry: string[] = customSubject
        ? canonicalSlug === legacySlug
            ? [legacySlug]
            : [legacySlug, canonicalSlug]
        : [canonicalSlug];
    if (!customSubject && legacySlug !== canonicalSlug) slugsToTry.push(legacySlug);
    // Pre-migration convergence: while stored roles are still legacy
    // tokens (LEGACY_RESOLUTION_NARROWED false), a caller passing an
    // ALREADY-canonical token (e.g. resolveCanonicalRole output) has lost
    // the stored legacy slug, so grant docs keyed by that slug
    // (roleDefinitions, permissions) would never be consulted and existing
    // grants silently break. Worst case is 'superadmin': LEGACY_TO_CATALOG
    // maps it to chief_technology_officer, a key with no grant docs at all,
    // so the founder's stored superadmin resolved to a role nothing grants
    // and every hasServerPermission gate denied him (live incident
    // 2026-10-22: /admin dashboard init 403, all counts zero). Reverse-
    // expand the candidate set with every legacy token that maps to the
    // canonical slug so stored grants keep resolving exactly as before
    // until the stored-role migration narrows resolution.
    // The expansion is skipped for custom subjects (SEC-04): no legacy
    // token may be added on a custom slug's behalf, so the 'superadmin'
    // shortcut below can never fire for one (a custom role whose parent
    // is chief_technology_officer still resolves only its own grants).
    if (!customSubject && !LEGACY_RESOLUTION_NARROWED) {
        for (const [legacy, catalog] of Object.entries(LEGACY_TO_CATALOG)) {
            if (catalog === canonicalSlug && !slugsToTry.includes(legacy)) slugsToTry.push(legacy);
        }
    }

    if (slugsToTry.includes('superadmin')) return true;

    try {
        const db = getDb();
        if (!db) {
            console.warn('[hasServerPermission] No db connection, falling back to static config map');
            return slugsToTry.some((slug) => hasPermissionForRole(slug as UserRole, permission));
        }

        // First existing Firestore doc wins: the canonical-slug doc is
        // preferred, the legacy-slug doc is honored exactly as before, so
        // existing grants are preserved while the taxonomy migrates.
        const firstExistingDoc = async (collection: string) => {
            for (const slug of slugsToTry) {
                const snap = await db.collection(collection).doc(slug).get();
                if (snap.exists) return snap;
            }
            return null;
        };

        // 1. Check dynamic roleDefinitions (Source of Truth)
        // roleDefinitions stores permissions as an array of keys: { permissions: ['canManageTasks', ...] }
        // The winning doc's array is AUTHORITATIVE: an explicit grant
        // returns true, anything else returns false. No fallthrough past the
        // winning doc, so a stale legacy/static entry can never contradict
        // the configured role.
        const roleDefDoc = await firstExistingDoc('roleDefinitions');
        if (roleDefDoc) {
            const data = roleDefDoc.data();
            if (data && Array.isArray(data.permissions)) {
                if (data.permissions.includes(permission)) return true;
                if (typeof data[permission] === 'boolean') return data[permission];
                return false;
            }
        }

        // 2. Fallback to legacy permissions collection (boolean map)
        const permDoc = await firstExistingDoc('permissions');
        if (permDoc) {
            const data = permDoc.data();
            if (data && typeof data[permission] === 'boolean') {
                return data[permission];
            }
        }
    } catch (error) {
        console.error(`[hasServerPermission] Error fetching permissions for role ${canonicalSlug}:`, error);
    }

    // 3. Fallback to static config mapping if Firestore lookup fails or key is missing.
    // Every candidate slug is tried so definitions keyed either way keep working.
    return slugsToTry.some((slug) => hasPermissionForRole(slug as UserRole, permission));
}

/**
 * Canonical role resolution (spec step 03, SEDS-DEV-SPEC-RBAC-2026-V1.0).
 * Single choke point for server-side role checks. Reads roles/{uid}.role
 * first (the declared source of truth, matching the client useUser() hook),
 * falls back to users/{uid}.role (then displayRole) ONLY when the roles doc
 * is missing or empty, then normalizes AT CHECK TIME: normalizeRoleSlug
 * first (legacy slug redirects), normalizeUserRole second (27-token
 * canonical map; already-canonical tokens pass through per 575d5bb).
 * Stored Firestore values are NEVER modified here.
 * Throws on Firestore failure so callers keep their existing error semantics.
 */
interface StoredRoleRecord {
  role: unknown;
  additionalRoles: unknown;
  expiresAt: unknown;
  expiresRoleKey: unknown;
  /** True when the fields came from roles/{uid}; the grant-expiry
   * fields (contracts section 2.2) exist only on that doc. */
  fromRolesDoc: boolean;
}

/**
 * The single roles-first read behind resolveCanonicalRole and
 * resolveHolderRoles: roles/{uid} is the source of truth; when its
 * primary is missing or blank, the users/{uid} mirror supplies the
 * primary (role, then displayRole) and its additionalRoles. Behaviour
 * for the primary matches resolveCanonicalRole's historical read
 * exactly.
 */
async function readStoredRoleRecord(
  db: admin.firestore.Firestore,
  uid: string
): Promise<StoredRoleRecord> {
  const roleSnap = await db.collection('roles').doc(uid).get();
  const roleData = (roleSnap.exists ? roleSnap.data() : null) as Record<string, unknown> | null;
  const primary = roleData?.role;
  if (typeof primary === 'string' && primary.trim()) {
    return {
      role: primary,
      additionalRoles: roleData?.additionalRoles,
      expiresAt: roleData?.expiresAt,
      expiresRoleKey: roleData?.expiresRoleKey,
      fromRolesDoc: true,
    };
  }
  const userSnap = await db.collection('users').doc(uid).get();
  const userData = ((userSnap.exists ? userSnap.data() : null) || {}) as Record<string, unknown>;
  return {
    role: userData.role || userData.displayRole || null,
    additionalRoles: userData.additionalRoles,
    expiresAt: undefined,
    expiresRoleKey: undefined,
    fromRolesDoc: false,
  };
}

export async function resolveCanonicalRole(
  db: admin.firestore.Firestore,
  uid: string
): Promise<string> {
  if (!uid) return 'guest';
  const record = await readStoredRoleRecord(db, uid);
  const slug = normalizeRoleSlug(typeof record.role === 'string' ? record.role : '');
  // Custom Roles contracts section 4.4 (plan R1): a custom slug is
  // never pre-floored to member_basic before permission checks see it.
  // verifyAuthentication consumes this function, so a stored custom
  // primary reaches hasServerPermission verbatim and the holder's
  // answer converges with the raw-token routes and the client session.
  // Every non-custom input resolves byte-identically to before.
  if (isCustomRoleSlug(slug)) return slug;
  return normalizeUserRole(slug);
}

/** Firestore instants arrive as Timestamp, Date, millis or ISO text. */
function expiryInstantOf(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'object') {
    const candidate = value as { toDate?: unknown; seconds?: unknown; _seconds?: unknown };
    if (typeof candidate.toDate === 'function') {
      const converted = (candidate.toDate as () => unknown)();
      return converted instanceof Date && !Number.isNaN(converted.getTime()) ? converted : null;
    }
    const seconds = typeof candidate.seconds === 'number'
      ? candidate.seconds
      : typeof candidate._seconds === 'number'
        ? candidate._seconds
        : null;
    if (seconds !== null) return new Date(seconds * 1000);
  }
  return null;
}

/**
 * Grant-expiry derivation (contracts section 2.2): the roles doc names
 * at most ONE pending expiring grant via expiresRoleKey, and that
 * grant is expired when now >= expiresAt (exclusive instant, governors
 * termEnd semantics). This mirrors the pure `customGrantStatus` helper
 * that contracts section 4.2 assigns to src/lib/custom-roles.ts.
 * MERGE NOTE: when that module lands, re-point this derivation at it
 * so the program keeps exactly one implementation.
 */
function isExpiredCustomGrant(record: StoredRoleRecord, slug: string, now: Date): boolean {
  if (!record.fromRolesDoc) return false;
  if (record.expiresRoleKey !== slug) return false;
  const instant = expiryInstantOf(record.expiresAt);
  return instant !== null && now.getTime() >= instant.getTime();
}

export interface ResolvedHolderRoles {
  /** Canonical primary role. A custom slug is returned verbatim when
   * the stored primary is one (never floored, per contracts 4.4). */
  role: string;
  /** Custom slugs held via additionalRoles, with expired grants
   * removed (contracts section 4.4: an expired grant contributes
   * nothing, whether or not the sweep has materialised it). */
  customRoles: string[];
}

/**
 * Holder resolution (contracts section 4.4): extends the roles-first
 * read behind resolveCanonicalRole to surface the holder's custom
 * grants alongside the canonical role. Custom roles live ONLY in
 * additionalRoles (contracts K2); the primary always resolves as
 * resolveCanonicalRole resolves it.
 */
export async function resolveHolderRoles(
  db: admin.firestore.Firestore,
  uid: string,
  now: Date = new Date()
): Promise<ResolvedHolderRoles> {
  if (!uid) return { role: 'guest', customRoles: [] };
  const record = await readStoredRoleRecord(db, uid);
  const primarySlug = normalizeRoleSlug(typeof record.role === 'string' ? record.role : '');
  const role = isCustomRoleSlug(primarySlug) ? primarySlug : normalizeUserRole(primarySlug);
  const held = new Set<string>();
  if (Array.isArray(record.additionalRoles)) {
    for (const entry of record.additionalRoles) {
      if (typeof entry !== 'string') continue;
      const slug = normalizeRoleSlug(entry);
      if (!isCustomRoleSlug(slug) || slug === primarySlug) continue;
      if (isExpiredCustomGrant(record, slug, now)) continue;
      held.add(slug);
    }
  }
  return { role, customRoles: [...held] };
}

/**
 * Holder-scoped permission check (contracts section 4.4): the union of
 * the canonical primary's answer and every held, unexpired custom
 * grant's answer, each subject evaluated under the same candidate
 * order and reserved-key strip as hasServerPermission. This is how the
 * mainstream path sees additionalRoles grants without any route
 * changing its hasServerPermission(auth.user.role, ...) call shape;
 * routes adopt it where a holder's custom grants must count. The
 * per-subject checks read through hasServerPermission's own getDb()
 * handle, as every existing call in that function already does.
 */
export async function hasServerPermissionForUser(
  db: admin.firestore.Firestore,
  uid: string,
  permission: PermissionKey,
  now: Date = new Date()
): Promise<boolean> {
  if (!uid) return false;
  const holder = await resolveHolderRoles(db, uid, now);
  if (await hasServerPermission(holder.role, permission)) return true;
  for (const slug of holder.customRoles) {
    if (await hasServerPermission(slug, permission)) return true;
  }
  return false;
}

/**
 * Resolve a user's effective role from their user document.
 * Now delegates to resolveCanonicalRole (spec step 03): roles/{uid}.role is
 * the source of truth, users/{uid}.role is the legacy fallback, and the
 * returned token is canonical-normalized at check time. Stored Firestore
 * values are never rewritten. Returns null when no uid is given or the read
 * fails, preserving this function's historical contract. (Side effect: the
 * known demotion-staleness defect is fixed, because the roles/ doc is now
 * read first instead of the stale users/ copy.)
 */
export async function resolveUserRole(
  db: admin.firestore.Firestore | string,
  uid?: string
): Promise<string | null> {
  // Backward-compatible 1-arg shape resolveUserRole(uid): no Firestore handle
  // is available, so the role cannot be resolved. Preserve the historical
  // deny-all behavior (return null) until these call sites are migrated to
  // pass getDb(). Migrating them would grant access, which needs an explicit
  // product decision, so this intentionally does not change runtime behavior.
  if (typeof db === 'string') return null;
  if (!uid) return null;
  try {
    return await resolveCanonicalRole(db, uid);
  } catch (e) {
    console.error('[resolveUserRole] failed for', uid, e);
    return null;
  }
}

/**
 * Roles that operate across all chapters. Every other role is chapter-scoped:
 * it may only act on users/resources inside its own chapter.
 */
const GLOBAL_ROLES = new Set([
  'superadmin',
  'admin',
  'president_national',
  'national_vice_president',
  'national_marketing',
]);

export function isChapterScopedRole(role: string | null | undefined): boolean {
  if (!role) return true; // unknown roles default to scoped (least privilege)
  return !GLOBAL_ROLES.has(normalizeRoleSlug(role));
}

/**
 * Enforce chapter scoping: a chapter-scoped actor may only act on targets
 * inside their own chapter. Global roles bypass. When chapter data is
 * missing on either side the check is fail-open (logged) so existing flows
 * without chapterId keep working; an explicit mismatch is always denied.
 */
export async function assertChapterAccess(
  db: admin.firestore.Firestore,
  actorUid: string,
  targetUid: string
): Promise<{ allowed: boolean; reason?: string }> {
  if (!actorUid || !targetUid || actorUid === targetUid) return { allowed: true };
  try {
    const [actorSnap, targetSnap] = await Promise.all([
      db.collection('users').doc(actorUid).get(),
      db.collection('users').doc(targetUid).get(),
    ]);
    const actorRole = actorSnap.exists
      ? (actorSnap.data()?.role || actorSnap.data()?.displayRole || null)
      : null;
    if (!isChapterScopedRole(actorRole)) return { allowed: true }; // global role
    const actorChapter = actorSnap.exists ? actorSnap.data()?.chapterId || null : null;
    const targetChapter = targetSnap.exists ? targetSnap.data()?.chapterId || null : null;
    if (!actorChapter || !targetChapter) return { allowed: true }; // cannot enforce without data
    if (actorChapter !== targetChapter) return { allowed: false, reason: `cross-chapter action denied (${actorChapter} -> ${targetChapter})` };
    return { allowed: true };
  } catch (e) {
    console.error('[assertChapterAccess] failed', e);
    return { allowed: true }; // fail-open on infra error, logged
  }
}
