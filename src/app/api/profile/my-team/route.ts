import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';

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

        const reports: any[] = [];
        const visitedIds = new Set<string>();
        visitedIds.add(userId);

        // Optimization: Fetch ALL users and relationships in one go if the team is small-ish,
        // but since we don't know the size, we'll keep recursion but OPTIMIZE it with Promise.all
        // and avoid N+1 reads where possible.
        // BETTER: Perform a BFS (Breadth-First Search) to allow parallel fetching at each level.

        let currentLevelIds = [userId];
        let depth = 0;
        const maxDepth = 10;

        while (currentLevelIds.length > 0 && depth <= maxDepth) {
            if (depth > 0) {
                // If we are at depth > 0, the IDs in currentLevelIds are the subordinates we found in the previous loop.
                // We need to fetch their details.
                // Note: We already have their IDs.
            }

            // Find all subordinates for ALL managers at this level in PARALLEL
            const nextLevelIds: string[] = [];

            // 1. New Relationships (Batch fetch? Firestore 'in' has limit 10. We have to map.)
            // We can fetch relationships where managerId IN [...currentLevelIds]
            // Constraint: 'in' query supports max 10 values. We must chunk.

            const chunks = [];
            for (let i = 0; i < currentLevelIds.length; i += 10) {
                chunks.push(currentLevelIds.slice(i, i + 10));
            }

            const results = await Promise.all(chunks.map(async (chunk) => {
                const [relSnap, userSnap] = await Promise.all([
                    db.collection('reporting_relationships').where('managerId', 'in', chunk).get(),
                    db.collection('users').where('managerId', 'in', chunk).get()
                ]);
                return { relSnap, userSnap };
            }));

            // Process results
            const subordinatesMap = new Map<string, { type: string, managerId: string }>();

            results.forEach(({ relSnap, userSnap }) => {
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
            });

            if (subordinatesMap.size === 0) break;

            const subIds = Array.from(subordinatesMap.keys());
            subIds.forEach(id => visitedIds.add(id));

            // Fetch User Details for these subordinates
            // Optimization: Chunked 'in' queries for 'users' collection by document ID (FieldPath.documentId())
            // Firestore allows fetching by documentId 'in' [...]
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
                        reports.push({
                            id: doc.id,
                            displayName: userData.displayName || 'Unknown',
                            email: userData.email || null,
                            photoURL: userData.photoURL || null,
                            role: userData.displayRole || userData.role || 'member',
                            chapterId: userData.chapterId,
                            managerId: rel.managerId,
                            depth: depth, // The depth of THESE reports is relative to logic. 
                            // Actually logic above is BFS. 
                            // Level 0 is User. Level 1 is Reports.
                            // So depth variable matches perfectly.
                            isDirectReport: depth === 0 && rel.type === 'direct',
                            relationType: rel.type
                        });
                        nextLevelIds.push(doc.id);
                    }
                });
            });

            currentLevelIds = nextLevelIds;
            depth++;
        }

        // Get current user info
        const currentUserDoc = await db.collection('users').doc(userId).get();
        const currentUserData = currentUserDoc.exists ? currentUserDoc.data() : null;

        // Sort
        reports.sort((a, b) => {
            if (a.isDirectReport !== b.isDirectReport) return a.isDirectReport ? -1 : 1;
            if (a.depth !== b.depth) return a.depth - b.depth;
            return (a.displayName || '').localeCompare(b.displayName || '');
        });

        const response = NextResponse.json({
            reports,
            totalCount: reports.length,
            directCount: reports.filter(r => r.isDirectReport).length,
            indirectCount: reports.filter(r => !r.isDirectReport).length,
            currentUser: currentUserData ? {
                id: userId,
                displayName: currentUserData.displayName,
                role: currentUserData.displayRole || currentUserData.role
            } : null
        });

        // Add Cache-Control for 30 seconds
        response.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
        return response;

    } catch (error) {
        console.error('[My Team API] Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
