import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import {
  isCatalogRoleKey,
  normalizeToCanonical,
  normalizeRoleSlug,
  ABOLISHED_KEYS,
  ROLE_CATALOG,
  FOUNDER_DISPLAY_TITLE,
} from '@/lib/role-catalog';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';
import { ADMIN_PERMISSIONS } from '@/config/permission-registry';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Custom roles (Custom Roles Fix Program, contracts.md Sections 1.1-1.5,
// 3.1). A genuinely new role is a `custom_` definition under a parent
// catalog role for exactly one chapter. These helpers are the route-local
// form of the shared validators contracts Section 4.2 places in
// src/lib/custom-roles.ts (data-model's file); the signatures match so the
// route can import from there once that module lands.
// ---------------------------------------------------------------------------

const CUSTOM_ROLE_PREFIX = 'custom_';
const RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES: readonly string[] = [
  'canManagePermissions',
  'canManageRoles',
];
const FORCED_CUSTOM_CATEGORY = 'Custom';

function customError(code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status: 400 });
}

/**
 * Returns a problem message, or null when the slug is a lawful custom
 * slug (contracts Section 1.1): `custom_` prefix, non-empty remainder,
 * the slug is exactly its own normalizeRoleSlug form, and the remainder
 * resolves to nothing known (no catalog key, no legacy token, no
 * abolished key) - a custom role may never shadow or echo a real role.
 */
function customSlugProblem(slug: string): string | null {
  const remainder = slug.slice(CUSTOM_ROLE_PREFIX.length);
  if (!remainder) {
    return `Custom role slug "${slug}" needs a name after the "${CUSTOM_ROLE_PREFIX}" prefix.`;
  }
  if (slug !== normalizeRoleSlug(slug)) {
    return `Custom role slug "${slug}" is not in normalized form ("${normalizeRoleSlug(slug)}").`;
  }
  // 'admin' is named invalid by contracts Section 1.1 alongside the
  // resolving remainders: it never appears in LEGACY_TO_CATALOG (it is
  // founder handling, resolved by resolveRoleForUid - see role-catalog),
  // so the canonical check alone would let custom_admin through.
  if (
    normalizeToCanonical(remainder) !== null ||
    ABOLISHED_KEYS.includes(remainder) ||
    remainder === 'admin'
  ) {
    return `Custom role slug "${slug}" echoes the existing role "${remainder}". Pick a different name.`;
  }
  // Reserved stems (contracts ADDENDUM R6): a remainder whose FIRST token
  // is founder / president / superadmin is refused even when the whole
  // remainder resolves to nothing known (e.g. custom_founder_assistant).
  const firstToken = remainder.split('_')[0];
  if (firstToken === 'founder' || firstToken === 'president' || firstToken === 'superadmin') {
    return `Custom role slug "${slug}" starts with the reserved word "${firstToken}". Pick a different name.`;
  }
  return null;
}

/**
 * Title impersonation (contracts Section 3.1, CUSTOM_TITLE_RESERVED): a
 * custom role may not wear a constitutional title. Matches the label
 * against every catalog title (trimmed, case-insensitive) and against
 * the catalog keys / title slugs, so "Chapter Design Chair" is refused
 * even though the catalog title reads "Chapter Design and Media Chair".
 */
function titleImpersonatesCatalog(label: string): boolean {
  const clean = label.trim().toLowerCase();
  const labelSlug = normalizeRoleSlug(label);
  if (!clean && !labelSlug) return false;
  const titles: string[] = [
    ...ROLE_CATALOG.map((r) => r.title),
    FOUNDER_DISPLAY_TITLE,
  ];
  return (
    titles.some((t) => t.trim().toLowerCase() === clean) ||
    ROLE_CATALOG.some((r) => r.key === labelSlug || normalizeRoleSlug(r.title) === labelSlug)
  );
}

/** contracts Section 1.4: a definition default term is a positive integer number of days, or null. */
function defaultTermDaysProblem(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return null;
  return 'defaultTermDays must be a positive integer (days) or null.';
}

/**
 * GET: Fetch all role permission documents.
 * Any admin can read these (needed for sidebar).
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    // Fetch from both collections and merge
    const [rdSnap, rpSnap] = await Promise.all([
      db.collection('roleDefinitions').get(),
      db.collection('role_permissions').get()
    ]);

    const rolesMap = new Map();

    // Prioritize new roleDefinitions
    rdSnap.docs.forEach(doc => {
      const data = doc.data();
      const slug = doc.id;
      rolesMap.set(slug, {
        id: doc.id,
        role: slug,
        label: data.name || data.label || slug,
        allowedPaths: data.allowedPaths || [],
        canAccessAdmin: data.canAccessAdmin !== false,
        ...data
      });
    });

    // Merge in role_permissions if not already present
    rpSnap.docs.forEach(doc => {
      if (!rolesMap.has(doc.id)) {
        const data = doc.data();
        rolesMap.set(doc.id, {
          id: doc.id,
          role: doc.id,
          label: data.label || doc.id,
          allowedPaths: data.allowedPaths || [],
          canAccessAdmin: data.canAccessAdmin !== false,
          ...data
        });
      }
    });

    const roles = Array.from(rolesMap.values()).sort((a, b) => a.label.localeCompare(b.label));

    return NextResponse.json({ roles });
  } catch (error) {
    console.error('[role-permissions] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch role permissions' }, { status: 500 });
  }
}

/**
 * POST: Create or update a role definition (Phase 2, spec B.5.3).
 *
 * This is the ONE gated catalog write. The drawer's save carries the complete
 * resulting payload in a single call; the server diffs it against the stored
 * definition and classifies the change:
 * - no stored definition            -> gate action 'create' (always gated)
 * - allowedPaths / canAccessAdmin /
 *   isActive / category changed     -> gate action 'permissions'
 * - scope changed                   -> gate action 'scope'
 * - description / responsibilities /
 *   capabilities / label only       -> ungated (still audited)
 *
 * On a gate pass, ONE batch writes roleDefinitions/{slug},
 * role_permissions/{slug}, and the permissions/{slug} mirror, so the three
 * stores can never again be left half-applied by a failure between writes.
 *
 * Body: {
 *   role: string, label: string, allowedPaths: string[], canAccessAdmin: boolean,
 *   description?, responsibilities?, capabilities?, category?, scope?,
 *   isActive?, consentRequestId?
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userRole = (auth.user as any).role || '';
    const callerUid = String((auth.user as any).userId || (auth.user as any).uid || '');
    const canManage = await hasServerPermission(userRole, 'canManagePermissions');
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: Insufficient permissions to manage role permissions' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const body = await request.json();
    const { role, label, allowedPaths, canAccessAdmin } = body;

    if (!role || typeof role !== 'string' || !role.trim()) {
      return NextResponse.json({ error: 'Role slug is required' }, { status: 400 });
    }
    if (!label || typeof label !== 'string') {
      return NextResponse.json({ error: 'Label is required' }, { status: 400 });
    }
    const pathsSent = Array.isArray(allowedPaths);
    if (!pathsSent && !Array.isArray(body.permissionKeys)) {
      return NextResponse.json(
        { error: 'allowedPaths (path model) or permissionKeys (drawer model) is required' },
        { status: 400 },
      );
    }

    const slug = role.trim().toLowerCase().replace(/\s+/g, '_');
    const consentRequestId =
      typeof body.consentRequestId === 'string' && body.consentRequestId
        ? body.consentRequestId
        : null;

    // Custom roles (contracts.md Sections 1.1-1.5, 3.1): a `custom_`
    // slug is a genuinely new, non-constitutional role under a parent
    // catalog role for one chapter. EVERY custom check runs here -
    // after the slug is fixed, before the closure, the classification
    // and the consent gate - because a rejected request must never
    // consume a hard-mode consent. Non-custom slugs never enter this
    // branch and keep the behaviour below byte-for-byte.
    let customCtx: { parentRoleKey: string; chapterId: string } | null = null;
    let customDefSnap: { exists: boolean; data: () => Record<string, unknown> | undefined } | null =
      null;
    if (slug.startsWith(CUSTOM_ROLE_PREFIX)) {
      // Slug grammar + anti-squat (Section 1.1).
      const slugProblem = customSlugProblem(slug);
      if (slugProblem) return customError('CUSTOM_SLUG_INVALID', slugProblem);

      // The custom branch needs the stored definition before field
      // validation; the read below reuses this snapshot.
      customDefSnap = await db.collection('roleDefinitions').doc(slug).get();
      const existingCustom = customDefSnap.exists
        ? (customDefSnap.data() as Record<string, unknown>)
        : null;

      // Reserved Powers ceiling (Section 1.5): rejected, never stripped,
      // on create AND on editor save - before classification, before
      // the gate, and before the forward-compat loop in the batch can
      // land a sent key in the evaluated permissions map as true.
      if (
        Array.isArray(body.permissionKeys) &&
        (body.permissionKeys as unknown[]).some(
          (k) => typeof k === 'string' && RESERVED_PERMISSION_KEYS_FOR_CUSTOM_ROLES.includes(k),
        )
      ) {
        return customError(
          'RESERVED_PERMISSION_FOR_CUSTOM_ROLE',
          'Custom roles can never hold canManagePermissions or canManageRoles (Reserved Powers).',
        );
      }

      // Title impersonation (Section 3.1).
      if (titleImpersonatesCatalog(label)) {
        return customError(
          'CUSTOM_TITLE_RESERVED',
          `The name "${label.trim()}" matches a catalog role title. Pick a different name.`,
        );
      }

      if (!existingCustom) {
        // CREATE (Section 3.1): parentRoleKey, chapterId and the
        // permissionKeys array are required. A path-model-only body
        // (the role-privileges page shape) cannot mint a custom role.
        if (
          !Array.isArray(body.permissionKeys) ||
          typeof body.parentRoleKey !== 'string' ||
          !body.parentRoleKey ||
          typeof body.chapterId !== 'string' ||
          !body.chapterId
        ) {
          return customError(
            'CUSTOM_FIELDS_REQUIRED',
            'Creating a custom role requires parentRoleKey, chapterId and a permissionKeys array.',
          );
        }
        if (!isCatalogRoleKey(body.parentRoleKey)) {
          return customError(
            'CUSTOM_PARENT_INVALID',
            `Parent role "${body.parentRoleKey}" is not a catalog role.`,
          );
        }
        const chapterSnap = await db.collection('chapters').doc(body.chapterId).get();
        if (!chapterSnap.exists || chapterSnap.data()?.isActive === false) {
          return customError(
            'CUSTOM_CHAPTER_INVALID',
            `Chapter "${body.chapterId}" does not exist or is inactive.`,
          );
        }
        if ('defaultTermDays' in body) {
          const termProblem = defaultTermDaysProblem(body.defaultTermDays);
          if (termProblem) return customError('CUSTOM_FIELDS_REQUIRED', termProblem);
        }
        customCtx = { parentRoleKey: body.parentRoleKey, chapterId: body.chapterId };
      } else {
        // UPDATE of an existing definition. Fail closed on a
        // hand-written doc that does not itself validate as a custom
        // definition (invariant 10: an editor save must never launder
        // one into legitimacy).
        if (
          existingCustom.isCustom !== true ||
          !isCatalogRoleKey(existingCustom.parentRoleKey) ||
          typeof existingCustom.chapterId !== 'string' ||
          !existingCustom.chapterId
        ) {
          return customError(
            'CUSTOM_DEFINITION_INVALID',
            `Stored definition "${slug}" is not a valid custom role definition.`,
          );
        }
        // Immutability (Section 1.2): isCustom, parentRoleKey and
        // chapterId never change after create. A body that OMITS one
        // of them is a no-change (the editor never sends them), not an
        // error; a body that sends a different value is refused.
        for (const field of ['isCustom', 'parentRoleKey', 'chapterId'] as const) {
          if (field in body && body[field] !== existingCustom[field]) {
            return customError(
              'CUSTOM_DEFINITION_INVALID',
              `Field "${field}" of a custom role cannot change after creation. Delete and recreate the role instead.`,
            );
          }
        }
        if ('defaultTermDays' in body) {
          const termProblem = defaultTermDaysProblem(body.defaultTermDays);
          if (termProblem) return customError('CUSTOM_FIELDS_REQUIRED', termProblem);
        }
        customCtx = {
          parentRoleKey: existingCustom.parentRoleKey as string,
          chapterId: existingCustom.chapterId as string,
        };
      }

      // allowedChapters pinning (Section 1.2): exactly [chapterId].
      if (
        Array.isArray(body.allowedChapters) &&
        body.allowedChapters.length > 0 &&
        !(
          body.allowedChapters.length === 1 && body.allowedChapters[0] === customCtx.chapterId
        )
      ) {
        return customError(
          'CUSTOM_CHAPTERS_WIDENED',
          'A custom role belongs to exactly one chapter: allowedChapters must be [chapterId].',
        );
      }

      // Forced fields (Sections 1.2, 3.1): whatever the client sent,
      // the stored scope and category are forced and the chapter list
      // is pinned, so a custom definition can never trip the
      // Category-B consent logic or claim a wider scope downstream.
      body.scope = 'chapter';
      body.category = FORCED_CUSTOM_CATEGORY;
      if (Array.isArray(body.permissionKeys)) {
        body.allowedChapters = [customCtx.chapterId];
      }
    }

    // Phase 1 closure (spec A.7): the catalog is closed. Permission docs
    // may only be written for roles that resolve to the catalog (a
    // catalog key or a legacy token in LEGACY_TO_CATALOG); inventing a
    // role here is a 400. (Integration step 4: the gates suite's
    // 'chair_events' cases exercise the legacy-token path; the doc stays
    // keyed by the caller-sent slug, as the gates flow built it.)
    // The one sanctioned exception is a validated `custom_` slug
    // (customCtx set by the block above): genuinely new roles enter
    // ONLY through that branch, never through the closure itself.
    if (!customCtx && !isCatalogRoleKey(slug) && !normalizeToCanonical(slug)) {
      return NextResponse.json(
        { error: `Unknown role "${slug}". Roles are fixed by the Role Catalog.` },
        { status: 400 },
      );
    }

    const cleanPaths = pathsSent
      ? (allowedPaths as unknown[]).filter((p: any) => typeof p === 'string')
      : [];
    const nextCanAccessAdmin = canAccessAdmin !== false;

    const rdRef = db.collection('roleDefinitions').doc(slug);
    // The custom branch already read this doc during validation; reuse
    // that snapshot so one request never reads the definition twice.
    const existingSnap = customDefSnap ?? (await rdRef.get());
    const existing = existingSnap.exists ? (existingSnap.data() as Record<string, unknown>) : null;
    const isCreate = !existingSnap.exists;

    // Build the full resulting update (only fields the caller actually sent
    // are written, so a permissions-only save never clobbers metadata).
    const updateData: Record<string, unknown> = {
      role: slug,
      slug,
      name: label.trim(),
      label: label.trim(),
      updatedAt: new Date(),
      updatedBy: callerUid || (auth.user as any).email || 'system',
    };
    // Only fields the caller actually sent are written: a drawer save must
    // not clobber path-model fields, and a path-model save must not clobber
    // drawer fields.
    if (pathsSent) updateData.allowedPaths = cleanPaths;
    if ('canAccessAdmin' in body) updateData.canAccessAdmin = nextCanAccessAdmin;
    if (typeof body.description === 'string') updateData.description = body.description;
    if (typeof body.responsibilities === 'string') updateData.responsibilities = body.responsibilities;
    if (Array.isArray(body.capabilities)) {
      updateData.capabilities = body.capabilities.filter((c: any) => typeof c === 'string');
    }
    if (typeof body.category === 'string') updateData.category = body.category;
    if (typeof body.scope === 'string') updateData.scope = body.scope;
    if (typeof body.isActive === 'boolean') updateData.isActive = body.isActive;
    // Drawer-model fields (spec B.5.3): the privileges drawer sends its
    // boolean permission keys + chapter scope list in the same one call.
    const isDrawerPayload = Array.isArray(body.permissionKeys);
    if (isDrawerPayload) {
      updateData.permissions = (body.permissionKeys as unknown[]).filter(
        (c: unknown) => typeof c === 'string',
      );
    }
    if (Array.isArray(body.allowedChapters)) {
      updateData.allowedChapters = (body.allowedChapters as unknown[]).filter(
        (c: unknown) => typeof c === 'string',
      );
    }
    if (isCreate) updateData.createdAt = new Date();
    // Custom definitions (contracts Sections 1.2, 1.4): the program
    // fields are stamped on create AND on update from the validated
    // context, so a merge write can never drop them. defaultTermDays
    // rides along only when the caller sent it (validated above).
    if (customCtx) {
      updateData.isCustom = true;
      updateData.parentRoleKey = customCtx.parentRoleKey;
      updateData.chapterId = customCtx.chapterId;
      if ('defaultTermDays' in body) updateData.defaultTermDays = body.defaultTermDays;
    }

    // Classify the change (spec B.5.2/B.5.3 diff table).
    const sameStringSet = (a: unknown, b: string[]): boolean => {
      const arr = Array.isArray(a) ? (a as unknown[]).filter((x) => typeof x === 'string') : [];
      return arr.length === b.length && arr.every((x) => b.includes(x as string));
    };
    let gateAction: 'create' | 'permissions' | 'scope' | null = null;
    const changedFields: string[] = [];
    if (isCreate) {
      gateAction = 'create';
      changedFields.push('created');
    } else if (existing) {
      if (pathsSent && !sameStringSet(existing.allowedPaths, cleanPaths)) changedFields.push('allowedPaths');
      if ('canAccessAdmin' in body && (existing.canAccessAdmin !== false) !== nextCanAccessAdmin) {
        changedFields.push('canAccessAdmin');
      }
      if (typeof body.isActive === 'boolean' && (existing.isActive !== false) !== body.isActive) {
        changedFields.push('isActive');
      }
      if (typeof body.category === 'string' && body.category !== existing.category) {
        changedFields.push('category');
      }
      if (isDrawerPayload) {
        const nextKeys = (updateData.permissions as string[]).slice().sort();
        const prevKeys = (Array.isArray(existing.permissions) ? [...(existing.permissions as string[])] : []).sort();
        if (JSON.stringify(nextKeys) !== JSON.stringify(prevKeys)) changedFields.push('permissionKeys');
      }
      if (changedFields.length > 0) gateAction = 'permissions';
      if (typeof body.scope === 'string' && body.scope !== existing.scope) {
        changedFields.push('scope');
        if (!gateAction) gateAction = 'scope';
      }
      for (const f of ['description', 'responsibilities', 'capabilities', 'name', 'label'] as const) {
        if (f in updateData && JSON.stringify(updateData[f]) !== JSON.stringify(existing[f === 'name' ? 'name' : f])) {
          if (!changedFields.includes(f)) changedFields.push(f);
        }
      }
    }

    if (gateAction) {
      const subjectRef: ConsentSubjectRef = {
        type: 'role_definition',
        slug,
        action: gateAction,
      };
      try {
        await assertConsentFor({
          db,
          actorUid: callerUid,
          matterKey: 'role_catalog',
          consentRequestId,
          subjectRef,
          actSummary: `${gateAction} role definition ${slug}`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }

    await writeGovernanceAuditOrThrow(db, {
      action: 'role_definition_saved',
      actorUid: callerUid,
      actorRole: userRole,
      targetType: 'role_definition',
      targetId: slug,
      details: { changedFields, gateAction, consentRequestId },
    });

    // One atomic batch for all three stores (spec B.5.3). For drawer
    // payloads the permissions/{slug} doc keeps the boolean-map shape the
    // rules and server permission checks evaluate; for path-model payloads
    // it keeps the allowedPaths mirror shape.
    let permissionsDocData: Record<string, unknown>;
    let rolePermissionsData: Record<string, unknown>;
    if (isDrawerPayload) {
      const keys = (updateData.permissions as string[]) ?? [];
      const booleanMap: Record<string, unknown> = {
        _scope: (updateData.scope as string) ?? (existing?.scope as string) ?? 'chapter',
        _allowedChapters: (updateData.allowedChapters as string[]) ?? [],
      };
      for (const key of Object.keys(ADMIN_PERMISSIONS)) {
        booleanMap[key] = keys.includes(key);
      }
      // Forward-compat: a sent key outside the registry still lands as true
      // rather than being silently dropped from the evaluated map.
      for (const key of keys) {
        if (!(key in booleanMap)) booleanMap[key] = true;
      }
      permissionsDocData = booleanMap;
      rolePermissionsData = {
        ...booleanMap,
        permissions: keys,
        label: updateData.label,
        allowedPaths: (updateData.allowedChapters as string[]) ?? cleanPaths,
        updatedAt: updateData.updatedAt,
        updatedBy: updateData.updatedBy,
      };
    } else {
      permissionsDocData = {
        allowedPaths: cleanPaths,
        canAccessAdmin: nextCanAccessAdmin,
        updatedAt: updateData.updatedAt,
        updatedBy: updateData.updatedBy,
      };
      rolePermissionsData = updateData;
    }

    const batch = db.batch();
    batch.set(rdRef, updateData, { merge: true });
    batch.set(db.collection('role_permissions').doc(slug), rolePermissionsData, { merge: true });
    batch.set(db.collection('permissions').doc(slug), permissionsDocData, { merge: true });
    await batch.commit();

    return NextResponse.json({ success: true, role: slug });
  } catch (error) {
    console.error('[role-permissions] POST error:', error);
    return NextResponse.json({ error: 'Failed to save role permissions' }, { status: 500 });
  }
}

/**
 * DELETE: Remove a role definition (Phase 2, spec B.5.3).
 * Gated (action 'delete') and atomic: roleDefinitions, role_permissions, and
 * the permissions mirror are deleted in one batch. (Previously this deleted
 * only role_permissions and left the definition behind.)
 * Body: { role: string, consentRequestId?: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userRole = (auth.user as any).role || '';
    const callerUid = String((auth.user as any).userId || (auth.user as any).uid || '');
    const canManage = await hasServerPermission(userRole, 'canManagePermissions');
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: Insufficient permissions to delete role permissions' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const body = await request.json().catch(() => ({}));
    const { role } = body;
    const consentRequestId =
      typeof body.consentRequestId === 'string' && body.consentRequestId
        ? body.consentRequestId
        : null;

    if (!role || role === 'superadmin') {
      return NextResponse.json({ error: 'Cannot delete superadmin or empty role' }, { status: 400 });
    }

    // Phase 1 closure (spec A.7): catalog roles cannot be deleted.
    if (isCatalogRoleKey(role)) {
      return NextResponse.json(
        { error: `Role "${role}" is a catalog role and cannot be deleted.` },
        { status: 403 },
      );
    }

    // Holders fence for custom definitions (Custom Roles Fix Program,
    // G5 defect D2): this route previously deleted all three stores
    // even while people still held the role. A custom role lives in
    // roles/{uid} additionalRoles (never the primary slot), so both
    // fields are checked; holders must be reassigned first. The fence
    // runs BEFORE the consent gate so a refused delete never consumes
    // a hard-mode consent. Non-custom deletes are untouched.
    // DEVIATION, recorded: contracts.md Section 3.1 says "DELETE:
    // unchanged"; the parent adopted G5's dissent over that silence
    // (deleting a definition out from under live holders is the exact
    // failure D2 flagged) and reports the deviation with the program.
    if (typeof role === 'string' && role.startsWith(CUSTOM_ROLE_PREFIX)) {
      const [primaryHolders, additionalHolders] = await Promise.all([
        db.collection('roles').where('role', '==', role).get(),
        db.collection('roles').where('additionalRoles', 'array-contains', role).get(),
      ]);
      const holderIds = new Set<string>();
      primaryHolders.docs.forEach((d: { id: string }) => holderIds.add(d.id));
      additionalHolders.docs.forEach((d: { id: string }) => holderIds.add(d.id));
      if (holderIds.size > 0) {
        const defSnap = await db.collection('roleDefinitions').doc(role).get();
        const defName =
          defSnap.exists && typeof defSnap.data()?.name === 'string'
            ? (defSnap.data()?.name as string)
            : role;
        return NextResponse.json(
          {
            error: `Role '${defName}' is still held by ${holderIds.size} user(s). Reassign them before deleting the role definition.`,
            code: 'CUSTOM_ROLE_IN_USE',
            holderCount: holderIds.size,
          },
          { status: 409 },
        );
      }
    }

    // Phase 2 consent gate (spec B.5.3) for the legacy (non-catalog) role
    // definitions that remain deletable: deletion is a Reserved Matter.
    try {
      await assertConsentFor({
        db,
        actorUid: callerUid,
        matterKey: 'role_catalog',
        consentRequestId,
        subjectRef: { type: 'role_definition', slug: role, action: 'delete' },
        actSummary: `Delete role definition ${role}`,
      });
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }

    await writeGovernanceAuditOrThrow(db, {
      action: 'role_definition_deleted',
      actorUid: callerUid,
      actorRole: userRole,
      targetType: 'role_definition',
      targetId: role,
      details: { consentRequestId },
    });

    const batch = db.batch();
    batch.delete(db.collection('roleDefinitions').doc(role));
    batch.delete(db.collection('role_permissions').doc(role));
    batch.delete(db.collection('permissions').doc(role));
    await batch.commit();

    return NextResponse.json({ success: true, deleted: role });
  } catch (error) {
    console.error('[role-permissions] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
