import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';

/**
 * GET: Workload Data for Sub-Hierarchy
 * Uses optimized BFS logic to find EVERY subordinate in the organizational tree.
 */
export async function GET(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const userId = auth.user.userId;
        ensureAdminInitialized();
        const db = getDb();
        if (!db) throw new Error('DB connection failed');

        const subordinates: any[] = [];
        const visitedIds = new Set<string>();
        visitedIds.add(userId);

        let currentLevelIds = [userId];
        let depth = 0;
        const maxDepth = 15; // Increased depth for massive trees

        while (currentLevelIds.length > 0 && depth <= maxDepth) {
            const nextLevelIds: string[] = [];
            const chunks = [];
            for (let i = 0; i < currentLevelIds.length; i += 10) {
                chunks.push(currentLevelIds.slice(i, i + 10));
            }

            const results = await Promise.all(chunks.map(async (chunk) => {
                const [relSnap, userSnap, managerIdsSnap] = await Promise.all([
                    db.collection('reporting_relationships').where('managerId', 'in', chunk).get(),
                    db.collection('users').where('managerId', 'in', chunk).get(),
                    // Also check for modern managerIds array if it exists
                    db.collection('users').where('managerIds', 'array-contains-any', chunk.map(id => ({ managerId: id }))).get().catch(() => ({ docs: [] }))
                ]);
                return { relSnap, userSnap, managerIdsSnap, chunk };
            }));

            const subordinatesMap = new Map<string, { type: string, managerId: string }>();

            results.forEach(({ relSnap, userSnap, managerIdsSnap, chunk }) => {
                relSnap.docs.forEach(doc => {
                    const data = doc.data();
                    if (data.subordinateId && !visitedIds.has(data.subordinateId)) {
                        subordinatesMap.set(data.subordinateId, { type: data.type || 'direct', managerId: data.managerId });
                    }
                });
                userSnap.docs.forEach(doc => {
                    if (!visitedIds.has(doc.id) && !subordinatesMap.has(doc.id)) {
                        subordinatesMap.set(doc.id, { type: 'direct', managerId: doc.data().managerId });
                    }
                });
                (managerIdsSnap.docs || []).forEach(doc => {
                    if (!visitedIds.has(doc.id) && !subordinatesMap.has(doc.id)) {
                        // Find which specific manager in the chunk this user belongs to
                        const mIds = doc.data().managerIds || [];
                        const foundManager = mIds.find((m: any) => chunk.includes(m.managerId));
                        if (foundManager) {
                            subordinatesMap.set(doc.id, { type: 'direct', managerId: foundManager.managerId });
                        }
                    }
                });
            });

            if (subordinatesMap.size === 0) break;

            const subIds = Array.from(subordinatesMap.keys());
            subIds.forEach(id => visitedIds.add(id));

            const subChunks = [];
            for (let i = 0; i < subIds.length; i += 10) {
                subChunks.push(subIds.slice(i, i + 10));
            }

            const userDocsSnaps = await Promise.all(subChunks.map(chunk =>
                db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get()
            ));

            userDocsSnaps.forEach(snap => {
                snap.docs.forEach(doc => {
                    const rel = subordinatesMap.get(doc.id);
                    if (rel) {
                        const userData = doc.data();
                        subordinates.push({
                            id: doc.id,
                            name: userData.displayName || userData.email || doc.id,
                            email: userData.email || null,
                            photoURL: userData.photoURL || null,
                            role: userData.displayRole || userData.role || 'member',
                            managerId: rel.managerId,
                            depth: depth + 1,
                            taskCount: userData.tasksAssignedCount || 0
                        });
                        nextLevelIds.push(doc.id);
                    }
                });
            });

            currentLevelIds = nextLevelIds;
            depth++;
        }

        // Fetch Role Definitions
        const rolesSnap = await db.collection('roleDefinitions').get();
        const roleDefinitions = rolesSnap.docs.map(doc => ({
            slug: doc.id,
            name: doc.data().name,
            description: doc.data().description,
            category: doc.data().category
        }));

        console.log(`[workload] BFS complete. Found ${subordinates.length} subordinates for user ${userId}`);

        return NextResponse.json({
            subordinates,
            roleDefinitions
        });

    } catch (error: any) {
        console.error('[workload] API Error:', error);
        return NextResponse.json({ error: 'Failed to retrieve hierarchy' }, { status: 500 });
    }
}
