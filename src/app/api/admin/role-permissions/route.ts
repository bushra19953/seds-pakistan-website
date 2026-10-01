import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

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
 * POST: Create or update a role's permissions.
 * Only superadmin or president_national can do this.
 *
 * Body: {
 *   role: string,           // e.g., "chair_marketing"
 *   label: string,          // e.g., "Marketing Chair"
 *   allowedPaths: string[], // e.g., ["/admin/blog", "/admin/announcements"]
 *   canAccessAdmin: boolean
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Use dynamic permission check
    const userRole = (auth.user as any).role || '';
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
    if (!Array.isArray(allowedPaths)) {
      return NextResponse.json({ error: 'allowedPaths must be an array' }, { status: 400 });
    }

    const slug = role.trim().toLowerCase().replace(/\s+/g, '_');

    const updateData = {
      role: slug,
      slug: slug, // Some parts of the system use 'slug'
      name: label.trim(), // new system use 'name'
      label: label.trim(), // legacy use 'label'
      allowedPaths: allowedPaths.filter((p: any) => typeof p === 'string'),
      canAccessAdmin: canAccessAdmin !== false,
      updatedAt: new Date(),
      updatedBy: (auth.user as any).uid || auth.user.email || 'system',
    };

    // Write to both for stability during migration
    await db.collection('roleDefinitions').doc(slug).set(updateData, { merge: true });
    await db.collection('role_permissions').doc(slug).set(updateData, { merge: true });

    // Also set createdAt if it's a new doc in either collection
    const rdRef = db.collection('roleDefinitions').doc(slug);
    const existingRD = await rdRef.get();
    if (!existingRD.exists || !existingRD.data()?.createdAt) {
      await rdRef.set({ createdAt: new Date() }, { merge: true });
    }

    const rpRef = db.collection('role_permissions').doc(slug);
    const existingRP = await rpRef.get();
    if (!existingRP.exists || !existingRP.data()?.createdAt) {
      await rpRef.set({ createdAt: new Date() }, { merge: true });
    }

    return NextResponse.json({ success: true, role: slug });
  } catch (error) {
    console.error('[role-permissions] POST error:', error);
    return NextResponse.json({ error: 'Failed to save role permissions' }, { status: 500 });
  }
}

/**
 * DELETE: Remove a role's permission document.
 * Body: { role: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Use dynamic permission check
    const userRole = (auth.user as any).role || '';
    const canManage = await hasServerPermission(userRole, 'canManagePermissions');
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: Insufficient permissions to delete role permissions' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const body = await request.json();
    const { role } = body;

    if (!role || role === 'superadmin') {
      return NextResponse.json({ error: 'Cannot delete superadmin or empty role' }, { status: 400 });
    }

    await db.collection('role_permissions').doc(role).delete();
    return NextResponse.json({ success: true, deleted: role });
  } catch (error) {
    console.error('[role-permissions] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
