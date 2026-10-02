import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { type PermissionKey } from '@/config/permissions.config';

export const dynamic = 'force-dynamic';

interface ReportingRelationship {
    id: string;
    subordinateId: string;
    managerId: string;
    type: 'direct' | 'dotted';
    createdAt: FirebaseFirestore.Timestamp | Date;
    createdBy: string;
}

// DAG Cycle Detection - DFS from managerId upward
async function wouldCreateCycle(
    db: FirebaseFirestore.Firestore,
    subordinateId: string,
    managerId: string
): Promise<{ hasCycle: boolean; path?: string[] }> {
    if (subordinateId === managerId) {
        return { hasCycle: true, path: [subordinateId, managerId] };
    }

    const visited = new Set<string>();
    const stack = [{ id: managerId, path: [managerId] }];

    while (stack.length > 0) {
        const current = stack.pop()!;

        if (current.id === subordinateId) {
            return { hasCycle: true, path: [...current.path, subordinateId] };
        }

        if (visited.has(current.id)) continue;
        visited.add(current.id);

        // Find all managers of the current node
        try {
            const managersSnapshot = await db.collection('reporting_relationships')
                .where('subordinateId', '==', current.id)
                .get();

            for (const doc of managersSnapshot.docs) {
                const rel = doc.data();
                if (rel.managerId && !visited.has(rel.managerId)) {
                    stack.push({ id: rel.managerId, path: [...current.path, rel.managerId] });
                }
            }

            // Also check legacy managerId field
            const userDoc = await db.collection('users').doc(current.id).get();
            if (userDoc.exists) {
                const legacyManagerId = userDoc.data()?.managerId;
                if (legacyManagerId && !visited.has(legacyManagerId)) {
                    stack.push({ id: legacyManagerId, path: [...current.path, legacyManagerId] });
                }
            }
        } catch (e) {
            console.error('Cycle check error:', e);
        }
    }

    return { hasCycle: false };
}

// POST: Add a reporting relationship
export async function POST(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const hasPerm = await hasServerPermission(auth.user.role as string, 'canManageUsers');
        if (!hasPerm) {
            return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
        }

        const body = await request.json();
        const subordinateId = body.subordinateId?.trim();
        const managerId = body.managerId?.trim();
        const type = body.type || 'direct';

        // Strict validation
        if (!subordinateId || typeof subordinateId !== 'string') {
            return NextResponse.json({ error: 'Valid subordinateId required' }, { status: 400 });
        }
        if (!managerId || typeof managerId !== 'string') {
            return NextResponse.json({ error: 'Valid managerId required' }, { status: 400 });
        }
        if (subordinateId === managerId) {
            return NextResponse.json({ error: 'Cannot report to yourself' }, { status: 400 });
        }
        if (!['direct', 'dotted'].includes(type)) {
            return NextResponse.json({ error: 'type must be "direct" or "dotted"' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // Check if both users exist
        const [subDoc, mgrDoc] = await Promise.all([
            db.collection('users').doc(subordinateId).get(),
            db.collection('users').doc(managerId).get()
        ]);

        if (!subDoc.exists) {
            return NextResponse.json({ error: 'Subordinate user not found' }, { status: 404 });
        }
        if (!mgrDoc.exists) {
            return NextResponse.json({ error: 'Manager user not found' }, { status: 404 });
        }

        // Check if relationship already exists
        const existingSnapshot = await db.collection('reporting_relationships')
            .where('subordinateId', '==', subordinateId)
            .where('managerId', '==', managerId)
            .get();

        if (!existingSnapshot.empty) {
            const existingDoc = existingSnapshot.docs[0];
            const existingData = existingDoc.data();
            if (existingData.type !== type) {
                await existingDoc.ref.update({ type, updatedAt: new Date() });
                return NextResponse.json({
                    success: true,
                    relationship: { id: existingDoc.id, subordinateId, managerId, type },
                    updated: true
                });
            }
            return NextResponse.json({
                success: true,
                relationship: { id: existingDoc.id, subordinateId, managerId, type: existingData.type },
                exists: true
            });
        }

        // Cycle detection
        const cycleCheck = await wouldCreateCycle(db, subordinateId, managerId);
        if (cycleCheck.hasCycle) {
            return NextResponse.json({
                error: 'Cycle detected',
                details: `Adding this relationship would create a cycle: ${cycleCheck.path?.join(' → ')}`,
                path: cycleCheck.path
            }, { status: 409 });
        }

        // Get creator ID - use email or id as fallback if uid not available
        const creatorId = (auth.user as any).uid || (auth.user as any).id || auth.user.email || 'system';

        // Create new relationship with validated data only
        const newRelData = {
            subordinateId: subordinateId,
            managerId: managerId,
            type: type as 'direct' | 'dotted',
            createdAt: new Date(),
            createdBy: creatorId
        };

        const docRef = await db.collection('reporting_relationships').add(newRelData);

        return NextResponse.json({
            success: true,
            relationship: { id: docRef.id, ...newRelData },
            created: true
        });

    } catch (error) {
        console.error('[Relationships API] POST Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to add relationship'
        }, { status: 500 });
    }
}

// DELETE: Remove a reporting relationship
export async function DELETE(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!(await hasServerPermission(auth.user.role as string, 'canManageUsers'))) {
            return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
        }

        const body = await request.json();
        const subordinateId = body.subordinateId?.trim();
        const managerId = body.managerId?.trim();

        console.log('[Relationships DELETE] Request:', { subordinateId, managerId, by: auth.user.email });

        if (!subordinateId || !managerId) {
            return NextResponse.json({ error: 'subordinateId and managerId required' }, { status: 400 });
        }

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // 1. Delete from reporting_relationships collection
        const snapshot = await db.collection('reporting_relationships')
            .where('subordinateId', '==', subordinateId)
            .where('managerId', '==', managerId)
            .get();

        let deletedFromCollection = false;
        if (!snapshot.empty) {
            // Delete all matching (should be 1)
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                console.log('[Relationships DELETE] Deleting doc:', doc.id);
                batch.delete(doc.ref);
            });
            await batch.commit();
            deletedFromCollection = true;
            console.log('[Relationships DELETE] Deleted', snapshot.docs.length, 'docs from reporting_relationships');
        } else {
            console.log('[Relationships DELETE] No docs found in reporting_relationships');
        }

        // 2. CRITICAL: Also clear legacy managerId field if it matches
        const userDoc = await db.collection('users').doc(subordinateId).get();
        let clearedLegacy = false;
        if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData?.managerId === managerId) {
                console.log('[Relationships DELETE] Clearing legacy managerId field on user:', subordinateId);
                await db.collection('users').doc(subordinateId).update({
                    managerId: null,
                    managerIdClearedAt: new Date(),
                    managerIdClearedBy: auth.user.email || 'system'
                });
                clearedLegacy = true;
                console.log('[Relationships DELETE] Legacy managerId cleared');
            } else {
                console.log('[Relationships DELETE] Legacy managerId does not match, skipping:', userData?.managerId, '!==', managerId);
            }
        }

        console.log('[Relationships DELETE] Complete:', { deletedFromCollection, clearedLegacy });

        return NextResponse.json({
            success: true,
            deleted: deletedFromCollection || clearedLegacy,
            deletedFromCollection,
            clearedLegacy
        });

    } catch (error) {
        console.error('[Relationships API] DELETE Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to delete relationship'
        }, { status: 500 });
    }
}

// GET: Fetch all relationships for a chapter
export async function GET(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const chapterId = searchParams.get('chapterId') || 'all';

        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        // Get all users in chapter
        let usersQuery = db.collection('users');
        if (chapterId !== 'all') {
            usersQuery = usersQuery.where('chapterId', '==', chapterId) as any;
        }
        const usersSnapshot = await usersQuery.get();
        const userIds = usersSnapshot.docs.map(d => d.id);

        if (userIds.length === 0) {
            return NextResponse.json({ relationships: [] });
        }

        // Get relationships - batch by 30 (Firestore limit)
        const relationships: any[] = [];
        const batchSize = 30;

        for (let i = 0; i < userIds.length; i += batchSize) {
            const batch = userIds.slice(i, i + batchSize);
            try {
                const snapshot = await db.collection('reporting_relationships')
                    .where('subordinateId', 'in', batch)
                    .get();

                snapshot.docs.forEach(doc => {
                    const data = doc.data();
                    // Only include valid relationships
                    if (data.subordinateId && data.managerId) {
                        relationships.push({
                            id: doc.id,
                            subordinateId: data.subordinateId,
                            managerId: data.managerId,
                            type: data.type || 'direct'
                        });
                    }
                });
            } catch (e) {
                console.error('Batch fetch error:', e);
            }
        }

        return NextResponse.json({ relationships });

    } catch (error) {
        console.error('[Relationships API] GET Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Failed to fetch relationships'
        }, { status: 500 });
    }
}
