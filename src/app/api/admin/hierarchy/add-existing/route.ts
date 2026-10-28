import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { syncDirectRelationship } from '@/lib/server/hierarchy';
import { resolveUserEmail } from '@/lib/server/user-contact';
import { bustIdentity } from '@/lib/server/identity-cache';
import {
    identityPrimaryFlagOn,
    primaryIdentitySet,
    primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';


export async function POST(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!(await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageUsers'))) {
            return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
        }

        const { userId, chapterId, managerId } = await request.json();

        if (!userId) {
            return NextResponse.json({ error: 'User ID required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // Verify user exists
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const userData = userDoc.data();

        // Cycle detection if managerId provided
        if (managerId) {
            let currentManagerId = managerId;
            const visited = new Set<string>();

            while (currentManagerId && visited.size < 100) {
                if (currentManagerId === userId) {
                    return NextResponse.json({
                        error: 'Cycle detected',
                        details: 'Cannot report to your own subordinate.'
                    }, { status: 409 });
                }
                visited.add(currentManagerId);
                const mgrDoc = await db.collection('users').doc(currentManagerId).get();
                if (!mgrDoc.exists) break;
                currentManagerId = mgrDoc.data()?.managerId;
            }
        }

        // Update user with new chapter and optional manager
        const updates: any = {
            updatedAt: new Date()
        };

        if (chapterId && chapterId !== 'all') {
            updates.chapterId = chapterId;
        }

        if (managerId !== undefined) {
            updates.managerId = managerId || null;
        }

        // WRITE PRIMACY (G-USER-1, U-07): adapter update primary
        // (loud — the swallowed-primary-failure class is reversed per
        // design) under isSupaPrimary('users'); Firestore update
        // demoted to best-effort reverse mirror.
        if (await identityPrimaryFlagOn('users')) {
            await primaryIdentityUpdate('users', 'users', userId, updates);
            try {
                await userRef.update(updates);
            } catch (mirrorErr) {
                console.error('[hierarchy/add-existing] Firestore reverse mirror failed after Supa primary commit:', mirrorErr);
            }
        } else {
            await userRef.update(updates);
        }
        // Read-Burn A (§2.5 W18): updates may set chapterId, an
        // identity-projection field. Bust directly after the update,
        // before the relationship mirror, so a mirror failure cannot
        // lose the bust.
        bustIdentity(userId);

        // Mirror any managerId write into the canonical reporting_relationships
        // collection so the legacy write path cannot drift from the canvas store.
        if (managerId !== undefined) {
            await syncDirectRelationship(userId, managerId || null, auth.user.userId);
        }

        // Contact doorway: the response email resolves through the
        // gated contact record (Firebase Auth fallback); the user
        // record no longer carries it.
        const resolvedEmail = await resolveUserEmail(db, userId)
            .catch(() => null);

        return NextResponse.json({
            success: true,
            user: {
                id: userId,
                displayName: userData?.displayName,
                email: resolvedEmail ?? undefined,
                photoURL: userData?.photoURL,
                role: userData?.displayRole || userData?.role,
                chapterId: updates.chapterId || userData?.chapterId,
                managerId: updates.managerId !== undefined ? updates.managerId : userData?.managerId
            }
        });

    } catch (error) {
        console.error('[Add Existing API] Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to add user'
        }, { status: 500 });
    }
}
