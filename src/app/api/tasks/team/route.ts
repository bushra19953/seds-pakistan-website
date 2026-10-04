import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { applyChapterScope } from '@/lib/server/chapter-scoping';

export const dynamic = 'force-dynamic';

// Optimized BFS using parallel batching
async function getSubordinateIds(db: FirebaseFirestore.Firestore, userId: string): Promise<string[]> {
    const subordinates: string[] = [];
    const visited = new Set<string>();
    visited.add(userId);
    let currentLevel = [userId];
    const maxDepth = 10;
    let depth = 0;

    while (currentLevel.length > 0 && depth < maxDepth) {
        const nextLevel: string[] = [];
        const chunks: string[][] = [];
        for (let i = 0; i < currentLevel.length; i += 10) {
            chunks.push(currentLevel.slice(i, i + 10));
        }

        const results = await Promise.all(chunks.map(async (chunk) => {
            const [relSnap, legacySnap] = await Promise.all([
                db.collection('reporting_relationships').where('managerId', 'in', chunk).get(),
                db.collection('users').where('managerId', 'in', chunk).get()
            ]);
            return { relSnap, legacySnap };
        }));

        results.forEach(({ relSnap, legacySnap }) => {
            relSnap.docs.forEach(doc => {
                const subId = doc.data().subordinateId;
                if (subId && !visited.has(subId)) {
                    visited.add(subId);
                    subordinates.push(subId);
                    nextLevel.push(subId);
                }
            });
            legacySnap.docs.forEach(doc => {
                if (!visited.has(doc.id)) {
                    visited.add(doc.id);
                    subordinates.push(doc.id);
                    nextLevel.push(doc.id);
                }
            });
        });

        currentLevel = nextLevel;
        depth++;
    }

    return subordinates;
}

async function getUserNames(db: FirebaseFirestore.Firestore, userIds: string[]): Promise<Record<string, string>> {
    if (userIds.length === 0) return {};
    const nameMap: Record<string, string> = {};
    const chunks: string[][] = [];
    for (let i = 0; i < userIds.length; i += 10) {
        chunks.push(userIds.slice(i, i + 10));
    }
    const snaps = await Promise.all(chunks.map(chunk =>
        db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get()
    ));
    snaps.forEach(snap => {
        snap.docs.forEach(doc => {
            nameMap[doc.id] = doc.data()?.displayName || doc.data()?.email || 'Unknown';
        });
    });
    return nameMap;
}

export async function GET(request: NextRequest) {
    try {
        const auth = await verifyAuthentication(request);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const userId = (auth.user as any).uid || (auth.user as any).userId || (auth.user as any).id;
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

        const userDataSnap = await db.collection('users').doc(userId).get();
        const userData = userDataSnap.data() || {};
        const userScopeData = { role: userData.role || 'member', chapterId: userData.chapterId };

        const tasks: any[] = [];
        const subordinateIds = await getSubordinateIds(db, userId);
        const allTeamMemberIds = [userId, ...subordinateIds];

        // Apply Scope to Query
        let tasksQuery = db.collection('tasks') as any;
        tasksQuery = await applyChapterScope(tasksQuery, userScopeData);

        // Fetch tasks
        const taskSnaps = await Promise.all([
            tasksQuery.where('assigneeId', 'in', allTeamMemberIds.slice(0, 10)).get(), // Limited for 'in' query
            // 'in' misses array-form co-assignees, so fan out array-contains per member too.
            ...allTeamMemberIds.slice(0, 10).map(uid => tasksQuery.where('assigneeIds', 'array-contains', uid).get()),
            tasksQuery.where('assignerId', '==', userId).get(),
            tasksQuery.where('createdBy', '==', userId).get()
        ]);

        const existingTaskIds = new Set<string>();
        taskSnaps.forEach(snap => {
            snap.docs.forEach((doc: any) => {
                if (existingTaskIds.has(doc.id)) return;
                existingTaskIds.add(doc.id);
                const data = doc.data();
                
                const serializeTs = (ts: any) => {
                    if (!ts) return null;
                    if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
                    return ts;
                };

                tasks.push({
                    id: doc.id,
                    title: data.title || 'Untitled Task',
                    status: data.status || 'pending',
                    priority: data.priority || 'medium',
                    assigneeId: data.assigneeId,
                    creatorId: data.assignerId || data.createdBy,
                    deadline: serializeTs(data.deadline),
                    createdAt: serializeTs(data.createdAt),
                    completedAt: serializeTs(data.completedAt),
                    isOverdue: data.deadline && new Date(data.deadline.toDate?.() || data.deadline) < new Date() && data.status !== 'completed',
                    points: data.points || 0,
                    workflowId: data.workflowId
                });
            });
        });

        // Resolve names
        const nameIds = new Set<string>();
        tasks.forEach(t => { if(t.assigneeId) nameIds.add(t.assigneeId); if(t.creatorId) nameIds.add(t.creatorId); });
        const nameMap = await getUserNames(db, Array.from(nameIds));

        const enrichedTasks = tasks.map(t => ({
            ...t,
            assigneeName: nameMap[t.assigneeId] || 'Unknown',
            creatorName: nameMap[t.creatorId] || 'System'
        }));

        return NextResponse.json({ tasks: enrichedTasks, teamSize: allTeamMemberIds.length });

    } catch (error: any) {
        console.error('[Team Tasks] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
