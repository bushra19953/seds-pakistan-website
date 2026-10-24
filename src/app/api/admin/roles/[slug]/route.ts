import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';
import { isFounderUid } from '@/config/founder';
import { hasServerPermission } from '@/lib/server/permissions';
import { isCatalogRoleKey } from '@/lib/role-catalog';
import { bustPermissionDoc } from '@/lib/server/identity-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE: role DEFINITION deletion.
 *
 * This route deletes a role definition (roleDefinitions/{slug}) and its
 * two permission mirrors (permissions/{slug} and role_permissions/{slug}).
 * Create writes all three stores, so delete retires all three - leaving
 * role_permissions behind would keep the role's grants readable after
 * its definition is gone (live verification finding, 2026-10-23). It
 * never deletes a PERSON: Workstream F (spec 2.5
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

        // Actor set (side-door plan 3.5, G5 D9): the Founder by UID
        // via config, or a role the permissions matrix grants
        // canManagePermissions. Nothing else suffices: the retired
        // role-string literals and the legacy fallback read of the
        // permissions doc grant nothing here.
        const hasPermission =
            isFounderUid(userId) ||
            (await hasServerPermission(userRole, 'canManagePermissions'));

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

        // Essential system roles stay name-protected. 'superadmin' is
        // deliberately NOT in this list anymore (founder-transfer
        // program, Family C): its protection is now reference-aware -
        // the holders fence below refuses the delete while anyone
        // still holds it, and once it is unreferenced the delete may
        // proceed through the consent gate like any other role.
        if (slug === 'president_national' || slug === 'member') {
            return NextResponse.json({ error: 'Cannot delete protected system roles' }, { status: 400 });
        }

        // 2. FENCE (Workstream F, spec 2.5 item D5; widened by the
        // founder-transfer program, Family C, to the full reference
        // set in founder-rederive-api.md section 10 items 1-3): refuse
        // while the slug is still referenced by ANY holder surface -
        // roles/{uid} primary 'role', roles/{uid} 'additionalRoles',
        // and the users/{uid} mirror ('role', 'displayRole', and
        // 'additionalRoles'), which role-writes.ts writes
        // transactionally and several gates still read. A primary-only
        // fence can never trip for a role held only in additionalRoles
        // or only in the mirror. The definition/grant docs keyed by
        // this slug are the deletion TARGETS, not references, and
        // historical audit stamps never block. Holder ids are unioned
        // across all five queries so one person counts once. Holders
        // must be reassigned through the role store or marked Departed
        // first. This route deletes a definition, never a person.
        // The fence runs BEFORE the consent gate so a refused delete
        // never consumes a hard-mode consent (the precedent already set
        // by the role-permissions route's fence).
        const holderSnaps = await Promise.all([
            db.collection('roles').where('role', '==', slug).get(),
            db.collection('roles').where('additionalRoles', 'array-contains', slug).get(),
            db.collection('users').where('role', '==', slug).get(),
            db.collection('users').where('displayRole', '==', slug).get(),
            db.collection('users').where('additionalRoles', 'array-contains', slug).get(),
        ]);
        const holderIds = new Set<string>();
        holderSnaps.forEach((snap: { docs: Array<{ id: string }> }) =>
            snap.docs.forEach((d: { id: string }) => holderIds.add(d.id)),
        );
        // QuerySnapshot.size equals docs.length in Firestore; the max
        // only guards snapshots that report a size without listing docs.
        const holderCount = Math.max(holderIds.size, ...holderSnaps.map((s: { size: number }) => s.size));
        if (holderCount > 0) {
            return NextResponse.json({
                error: `Role '${roleData.name}' is still held by ${holderCount} user(s). Reassign or depart them before deleting the role definition.`,
                holderCount
            }, { status: 409 });
        }

        // Catalog-slug block (adoption pack item 23 / RP-13 sub-finding):
        // mirror the UI route (role-permissions DELETE), which refuses
        // catalog slugs with this exact 403 body - both doors must
        // enforce the same rule. Placed after the holders fence (and
        // after the protected-slug check above) so the fence's 409 for
        // a still-held catalog slug (e.g. founder_patron) and the
        // protected slugs' 400 keep their established precedence; a
        // holderless catalog slug is refused here, before the consent
        // gate, so the refusal never consumes a consent.
        if (isCatalogRoleKey(slug)) {
            return NextResponse.json(
                { error: `Role "${slug}" is a catalog role and cannot be deleted.` },
                { status: 403 },
            );
        }

        // Phase 2 consent gate (spec B.5.3): deleting a role definition is a
        // Reserved Matter, whichever route performs it. The consent id is
        // accepted from the JSON body or the ?consentRequestId= query param.
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

        console.log(`[Role-Definition-Delete] Deleting role definition: ${slug} (${roleData.name})`);

        const batch = db.batch();

        // Delete the role definition
        batch.delete(roleRef);

        // Delete the associated permissions document
        batch.delete(db.collection('permissions').doc(slug));

        // Delete the role_permissions mirror too (three-store coherence:
        // create writes roleDefinitions + permissions + role_permissions)
        batch.delete(db.collection('role_permissions').doc(slug));

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

        // Read-Burn A (§2.5 W13): definition removal busts both tiers.
        bustPermissionDoc('roleDefinitions', slug);
        bustPermissionDoc('permissions', slug);

        return NextResponse.json({
            success: true,
            message: `Role definition '${roleData.name}' deleted.`
        });

    } catch (error: any) {
        console.error('[role-delete] error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}
