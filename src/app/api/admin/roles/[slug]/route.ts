import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE: role DEFINITION deletion.
 *
 * This route deletes a role definition (roleDefinitions/{slug}) and its
 * permissions doc. It never deletes a PERSON: Workstream F (spec 2.5
 * item D5) fences it to refuse while any roles/{uid} doc still holds
 * the role, so holders must first be reassigned through the role store
 * or marked Departed. (It previously also reverted every holder to
 * 'member' in the same batch; that silent mass-revert is removed.)
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
        // Founder UID and president_national are treated as peers of superadmin
        let hasPermission = userRole === 'superadmin'
            || userId === 'pLW0PuQCTAQHCNK1SfllVhPZdMz1'
            || userRole === 'president_national';
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

        // Phase 2 consent gate (spec B.5.3): deleting a role definition is a
        // Reserved Matter, whichever route performs it. The consent id is
        // accepted from the JSON body or the ?consentRequestId= query param.
        // (Integration step 4: gate runs first, then the Workstream F fence
        // below - both guards stand.)
        const deleteBody = await request.clone().json().catch(() => ({}));
        const consentRequestId =
            (typeof deleteBody?.consentRequestId === 'string' && deleteBody.consentRequestId
                ? deleteBody.consentRequestId
                : null) ?? new URL(request.url).searchParams.get('consentRequestId');
        try {
            await assertConsentFor({
                db,
                actorUid: userId,
                matterKey: 'role_catalog',
                consentRequestId,
                subjectRef: { type: 'role_definition', slug, action: 'delete' },
                actSummary: `Delete role definition ${slug} (nuclear delete route)`,
            });
        } catch (err) {
            const { status, body: errBody } = consentGateHttpError(err);
            return NextResponse.json(errBody, { status });
        }

        // 2. FENCE (Workstream F, spec 2.5 item D5): refuse while any
        // roles/{uid} doc still holds this role. Holders are people;
        // they must be reassigned through the role store or marked
        // Departed first. This route deletes a definition, never a person.
        const usersWithRoleSnap = await db.collection('roles').where('role', '==', slug).get();
        if (!usersWithRoleSnap.empty) {
            return NextResponse.json({
                error: `Role '${roleData.name}' is still held by ${usersWithRoleSnap.size} user(s). Reassign or depart them before deleting the role definition.`,
                holderCount: usersWithRoleSnap.size
            }, { status: 409 });
        }

        console.log(`[Role-Definition-Delete] Deleting role definition: ${slug} (${roleData.name})`);

        const batch = db.batch();

        // Delete the role definition
        batch.delete(roleRef);

        // Delete the associated permissions document
        batch.delete(db.collection('permissions').doc(slug));

        // 3. Log the action in audit logs
        const auditRef = db.collection('audit_logs').doc();
        batch.set(auditRef, {
            type: 'ROLE_DEFINITION_DELETE',
            actorId: userId,
            actorName: auth.user.displayName || auth.user.email,
            targetId: slug,
            data: {
                roleName: roleData.name,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

        return NextResponse.json({
            success: true,
            message: `Role definition '${roleData.name}' deleted.`
        });

    } catch (error: any) {
        console.error('[role-delete] error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}
