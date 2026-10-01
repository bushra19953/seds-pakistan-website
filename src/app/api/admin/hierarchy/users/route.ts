import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ 
                error: 'Unauthorized', 
                details: auth.error || 'No additional details provided by verifyAuthentication',
                userPresent: !!auth.user
            }, { status: 401 });
        }

        const hasPerm = await hasServerPermission(auth.user.role as string, 'canViewHierarchy');
        if (!hasPerm) {
            return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const chapterId = searchParams.get('chapterId');

        if (!chapterId) {
            return NextResponse.json({ error: 'Chapter ID is required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // Fetch Users
        let queryRef: FirebaseFirestore.Query = db.collection('users');
        if (chapterId !== 'all') {
            queryRef = queryRef.where('chapterId', '==', chapterId);
        }
        const snapshot = await queryRef.get();
        const userIds = snapshot.docs.map(d => d.id);

        // Fetch ALL relationships for these users (many-to-many)
        const relationshipsMap: Record<string, Array<{ managerId: string; type: 'direct' | 'dotted' }>> = {};

        if (userIds.length > 0) {
            const batchSize = 30;
            for (let i = 0; i < userIds.length; i += batchSize) {
                const batch = userIds.slice(i, i + batchSize);
                const relSnapshot = await db.collection('reporting_relationships')
                    .where('subordinateId', 'in', batch)
                    .get();

                relSnapshot.docs.forEach(doc => {
                    const data = doc.data();
                    if (!relationshipsMap[data.subordinateId]) {
                        relationshipsMap[data.subordinateId] = [];
                    }
                    relationshipsMap[data.subordinateId].push({
                        managerId: data.managerId,
                        type: data.type || 'direct'
                    });
                });
            }
        }

        const users = snapshot.docs.map(doc => {
            const data = doc.data();
            const userId = doc.id;

            // Get managers from new collection, fallback to legacy managerId
            let managerIds = relationshipsMap[userId] || [];

            // If no relationships found but legacy managerId exists, use that
            if (managerIds.length === 0 && data.managerId) {
                managerIds = [{ managerId: data.managerId, type: 'direct' as const }];
            }

            return {
                id: userId,
                displayName: data.displayName || 'Unknown',
                email: data.email || null,
                photoURL: data.photoURL || null,
                role: data.displayRole || data.role || 'member',
                chapterId: data.chapterId,
                // NEW: Array of managers instead of single managerId
                managerIds,
                // LEGACY: Keep for backward compatibility
                managerId: managerIds.length > 0 ? managerIds[0].managerId : null,
            };
        });

        return NextResponse.json({ users });

    } catch (error) {
        console.error('[Hierarchy Users API] Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
