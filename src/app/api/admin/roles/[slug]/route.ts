import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE: Nuclear Role Deletion
 * 1. Deletes the role definition.
 * 2. Reverts all users with this role to 'member'.
 * 3. Revokes all associated permissions.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: { slug: string } }
) {
    try {
        const { slug } = params;
        if (!slug) {
            return NextResponse.json({ error: 'Role slug is required' }, { status: 400 });
        }

        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        const userRole = auth.user.role;
        const userId = auth.user.userId;

        // Only superadmin or those with manageRoles permission can delete roles
        let hasPermission = userRole === 'superadmin';
        if (!hasPermission) {
            const permSnap = await db.collection('permissions').doc(userRole).get();
            hasPermission = !!permSnap.data()?.manageRoles;
        }

        if (!hasPermission) {
            return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
        }

        // 1. Check if role exists
        const roleRef = db.collection('roleDefinitions').doc(slug);
        const roleSnap = await roleRef.get();
        if (!roleSnap.exists) {
            return NextResponse.json({ error: 'Role definition not found' }, { status: 404 });
        }

        const roleData = roleSnap.data()!;

        // Prevent deleting superadmin or essential system roles if they match the slug
        if (slug === 'superadmin' || slug === 'president_national' || slug === 'member') {
            return NextResponse.json({ error: 'Cannot delete protected system roles' }, { status: 400 });
        }

        console.log(`[Nuclear-Delete] Starting deletion for role: ${slug} (${roleData.name})`);

        // 2. Find all users with this role and revert to member
        // In this system, user roles are stored in the 'roles' collection: roles/{uid} -> { role: 'slug' }
        // We need to query the 'roles' collection where 'role' == slug
        const usersWithRoleSnap = await db.collection('roles').where('role', '==', slug).get();
        
        const batch = db.batch();
        
        // Delete the role definition
        batch.delete(roleRef);
        
        // Delete the associated permissions document
        batch.delete(db.collection('permissions').doc(slug));

        // Revert users
        let affectedUserCount = 0;
        usersWithRoleSnap.forEach(userDoc => {
            batch.update(userDoc.ref, { 
                role: 'member',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                revertedFrom: slug,
                reversionReason: 'Role definition deleted'
            });
            affectedUserCount++;
        });

        // 3. Log the action in audit logs
        const auditRef = db.collection('audit_logs').doc();
        batch.set(auditRef, {
            type: 'ROLE_NUCLEAR_DELETE',
            actorId: userId,
            actorName: auth.user.displayName || auth.user.email,
            targetId: slug,
            data: {
                roleName: roleData.name,
                affectedUserCount,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

        return NextResponse.json({ 
            success: true, 
            message: `Role '${roleData.name}' deleted. ${affectedUserCount} users reverted to member status.`,
            affectedUserCount 
        });

    } catch (error: any) {
        console.error('[role-delete] error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}
