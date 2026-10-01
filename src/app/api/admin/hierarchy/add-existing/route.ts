import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermissionForRole } from '@/config/permissions.config';

export async function POST(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!hasPermissionForRole(auth.user.role as any, 'canManageUsers')) {
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

        await userRef.update(updates);

        return NextResponse.json({
            success: true,
            user: {
                id: userId,
                displayName: userData?.displayName,
                email: userData?.email,
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
