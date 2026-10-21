import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { isCatalogRoleKey } from '@/lib/role-catalog';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';
import { ADMIN_PERMISSIONS } from '@/config/permission-registry';

export const dynamic = 'force-dynamic';

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

    // Phase 1 closure (spec A.7): the catalog is closed. Permission docs
    // may only be written for catalog keys; inventing a role here is a 400.
    if (!isCatalogRoleKey(slug)) {
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
    const existingSnap = await rdRef.get();
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
