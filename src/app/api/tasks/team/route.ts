import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { applyChapterScope } from '@/lib/server/chapter-scoping';
import { isTerminalTaskStatus } from '@/lib/workflow-progress';
import { statusExemptsOverdue } from '@/lib/deadline-fairness';
import {
    getUserDocViaSeam,
    listDocsViaSeam,
    listTasksViaSeam,
    teamChapterWhereClause,
    type SupaWhereClause,
} from '@/lib/supa/seam-tasks-lists';

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

// Supa twin of getSubordinateIds: same BFS, same chunking, same
// visited/order semantics, reads via the seam. Returns null when the seam
// is unavailable (flag OFF / adapter absent / adapter error) so the caller
// uses the Firestore path above verbatim.
async function getSubordinateIdsSupa(userId: string): Promise<string[] | null> {
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

        for (const chunk of chunks) {
            const relSnap = await listDocsViaSeam('reporting_relationships', { where: [['managerId', 'in', chunk]] });
            if (!relSnap) return null;
            const legacySnap = await listDocsViaSeam('users', { where: [['managerId', 'in', chunk]] });
            if (!legacySnap) return null;

            relSnap.docs.forEach(doc => {
                const subId = doc.data()?.subordinateId;
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
        }

        currentLevel = nextLevel;
        depth++;
    }

    return subordinates;
}

// Supa twin of getUserNames: per-id doc gets via the seam (the adapter
// addresses document ids directly, so no documentId() 'in' query is
// needed). Returns null for Firestore fallback.
async function getUserNamesSupa(userIds: string[]): Promise<Record<string, string> | null> {
    if (userIds.length === 0) return {};
    const nameMap: Record<string, string> = {};
    for (const uid of userIds) {
        const doc = await getUserDocViaSeam(uid);
        if (!doc) return null;
        if (doc.exists) {
            nameMap[doc.id] = doc.data()?.displayName || 'Unknown';
        }
    }
    return nameMap;
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
            nameMap[doc.id] = doc.data()?.displayName || 'Unknown';
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

        const seamUserSnap = await getUserDocViaSeam(userId);
        const userDataSnap = seamUserSnap ?? await db.collection('users').doc(userId).get();
        const userData = userDataSnap.data() || {};
        const userScopeData = { role: userData.role || 'member', chapterId: userData.chapterId };

        const tasks: any[] = [];
        const seamSubordinateIds = await getSubordinateIdsSupa(userId);
        const subordinateIds = seamSubordinateIds ?? await getSubordinateIds(db, userId);
        const allTeamMemberIds = [userId, ...subordinateIds];

        // Fetch tasks. Firestore 'in' queries accept at most 10 values, so
        // chunk the whole subtree (same chunking pattern as getSubordinateIds
        // and getUserNames) instead of silently dropping members past 10.
        const memberChunks: string[][] = [];
        for (let i = 0; i < allTeamMemberIds.length; i += 10) {
            memberChunks.push(allTeamMemberIds.slice(i, i + 10));
        }

        // Supa path (flag ON): the same legs via the seam, with the chapter
        // clause teamChapterWhereClause derives from the same legacy-scope
        // inputs applyChapterScope uses below. NO status filter is added:
        // the current route intentionally returns the caller's tasks + the
        // whole reporting subtree + everything they assigned, forever (see
        // supa-rebase-notes/tasks-2.md for the defect-branch interaction).
        // Any leg returning null (flag OFF / adapter problem) drops to the
        // Firestore path below, unchanged.
        let taskSnaps: any[] | null = null;
        {
            const chapterClause = teamChapterWhereClause(userScopeData);
            const withChapter = (clause: SupaWhereClause): SupaWhereClause[] =>
                chapterClause ? [clause, chapterClause] : [clause];
            const legWheres: SupaWhereClause[][] = [
                ...memberChunks.map(chunk => withChapter(['assigneeId', 'in', chunk])),
                ...memberChunks.flatMap(chunk => chunk.map(uid => withChapter(['assigneeIds', 'array-contains', uid]))),
                withChapter(['assignerId', '==', userId]),
                withChapter(['createdBy', '==', userId]),
            ];
            const seamTaskSnaps: any[] = [];
            let seamOk = true;
            for (const where of legWheres) {
                const snap = await listTasksViaSeam(where);
                if (!snap) { seamOk = false; break; }
                seamTaskSnaps.push(snap);
            }
            if (seamOk) taskSnaps = seamTaskSnaps;
        }

        if (!taskSnaps) {
            // Apply Scope to Query
            let tasksQuery = db.collection('tasks') as any;
            tasksQuery = await applyChapterScope(tasksQuery, userScopeData);

            taskSnaps = await Promise.all([
                // One 'in' query per chunk covers all members' single-assignee tasks.
                // Per-leg bound (read-bleed hardening): every Firestore leg
                // below carries .limit(200); no orderBy is added (index risk),
                // and the BFS / in-memory dedupe + filter are unchanged.
                ...memberChunks.map(chunk => tasksQuery.where('assigneeId', 'in', chunk).limit(200).get()),
                // 'in' misses array-form co-assignees, so fan out array-contains
                // per member too, one query per member across all chunks.
                ...memberChunks.flatMap(chunk => chunk.map(uid => tasksQuery.where('assigneeIds', 'array-contains', uid).limit(200).get())),
                tasksQuery.where('assignerId', '==', userId).limit(200).get(),
                tasksQuery.where('createdBy', '==', userId).limit(200).get()
            ]);
        }

        const existingTaskIds = new Set<string>();
        taskSnaps.forEach(snap => {
            snap.docs.forEach((doc: any) => {
                if (existingTaskIds.has(doc.id)) return;
                const data = doc.data();
                // Terminal work (canonical 'completed' + legacy
                // 'approved') never belongs on the active team list.
                // Filtered here, server-side, so finished tasks drain
                // for every caller instead of relying on each client.
                if (isTerminalTaskStatus(data.status)) return;
                existingTaskIds.add(doc.id);

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
                    // Deadline fairness (founder rule, 2026-10-26):
                    // terminal states and submitted-for-review never
                    // count as overdue on the team list; a submission
                    // waiting on its reviewer is not late.
                    isOverdue: data.deadline && new Date(data.deadline.toDate?.() || data.deadline) < new Date() && !statusExemptsOverdue(data.status),
                    points: data.points || 0,
                    workflowId: data.workflowId
                });
            });
        });

        // Resolve names
        const nameIds = new Set<string>();
        tasks.forEach(t => { if(t.assigneeId) nameIds.add(t.assigneeId); if(t.creatorId) nameIds.add(t.creatorId); });
        const seamNameMap = await getUserNamesSupa(Array.from(nameIds));
        const nameMap = seamNameMap ?? await getUserNames(db, Array.from(nameIds));

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
