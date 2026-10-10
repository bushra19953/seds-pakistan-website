import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermissionForRole } from '@/config/permissions.config';
import { syncDirectRelationship, wouldCreateCycle } from '@/lib/server/hierarchy';

export async function POST(request: NextRequest) {
    try {
        // 1. Auth check
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // Need write permission - reusing canManageUsers or adding specific one?
        // Using canManageUsers for edits as per prompt implying strict control
        if (!hasPermissionForRole(auth.user.role as any, 'canManageUsers')) {
            return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
        }

        const { userId, newManagerId } = await request.json();

        if (!userId) {
            return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // 2. Cycle Detection (shared with the canonical write path)
        if (newManagerId) {
            const cycleCheck = await wouldCreateCycle(userId, newManagerId);
            if (cycleCheck.hasCycle) {
                return NextResponse.json({
                    error: 'Cycle detected',
                    details: 'Cannot report to your own subordinate.'
                }, { status: 409 });
            }
        }

        // 3. Transactional Update of the legacy field
        await db.runTransaction(async (t) => {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error('User not found');

            // Optional: Update permissions based on new manager?
            // For now, just link.
            t.update(userRef, {
                managerId: newManagerId || null,
                managerUpdatedAt: new Date()
            });
        });

        // 4. Mirror into the canonical reporting_relationships collection so the
        //    legacy write path cannot drift from the /admin/hierarchy canvas store.
        const mirror = await syncDirectRelationship(userId, newManagerId || null, auth.user.userId);

        return NextResponse.json({ success: true, managerId: newManagerId, mirror });

    } catch (error) {
        console.error('[Hierarchy Move API] Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal Server Error'
        }, { status: 500 });
    }
}
