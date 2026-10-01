import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as path from 'path';

// Target User ID for Muhammad Zubair Mongol (extracted from screenshot/context if possible, but I will search for it first)
async function diagnoseZubairTasks() {
    const serviceAccountPath = path.resolve(process.cwd(), 'seds-pakistan-service-account.json');
    const serviceAccount = require(serviceAccountPath);

    initializeApp({
        credential: cert(serviceAccount)
    });

    const db = getFirestore();
    
    // 1. Find the User ID for Muhammad Zubair Mongol
    const usersSnap = await db.collection('users')
        .where('displayName', '==', 'Muhammad Zubair Mongol')
        .get();
    
    if (usersSnap.empty) {
        console.error('❌ Could not find user: Muhammad Zubair Mongol');
        return;
    }

    const userDoc = usersSnap.docs[0];
    const userId = userDoc.id;
    console.log(`🔍 Found User: ${userDoc.data().displayName} (${userId})`);

    // 2. Get Counts
    console.log('\n--- Step 1: Firestore Document Counts ---');
    
    // Total tasks in collection
    const totalTasks = await db.collection('tasks').count().get();
    console.log(`Total tasks in collection: ${totalTasks.data().count}`);

    // assigneeId filter
    const assigneeTasks = await db.collection('tasks')
        .where('assigneeId', '==', userId)
        .get();
    console.log(`Tasks where assigneeId == userId: ${assigneeTasks.size}`);

    // workflowParticipantIds filter
    const workflowTasks = await db.collection('tasks')
        .where('workflowParticipantIds', 'array-contains', userId)
        .get();
    console.log(`Tasks where workflowParticipantIds contains userId: ${workflowTasks.size}`);

    // Unique combined
    const allIds = new Set<string>();
    assigneeTasks.docs.forEach(d => allIds.add(d.id));
    workflowTasks.docs.forEach(d => allIds.add(d.id));
    console.log(`Total Unique Tasks (Assignee OR Participant) for Zubair: ${allIds.size}`);

    // 3. Analyze the "Missing" Tasks
    console.log('\n--- Step 2: Analyzing "Missing" Tasks (Not directly linked to Zubair) ---');
    const allTasksSnap = await db.collection('tasks').get();
    const missingTasks = allTasksSnap.docs.filter(doc => !allIds.has(doc.id));
    
    console.log(`Number of tasks not directly linked to Zubair: ${missingTasks.length}`);

    const assigneeCounts: Record<string, number> = {};
    const noAssigneeIds: string[] = [];

    for (const doc of missingTasks) {
        const data = doc.data();
        const assigneeId = data.assigneeId;
        if (assigneeId) {
            assigneeCounts[assigneeId] = (assigneeCounts[assigneeId] || 0) + 1;
        } else {
            noAssigneeIds.push(doc.id);
        }
    }

    console.log('\nAssignees of missing tasks:');
    for (const [id, count] of Object.entries(assigneeCounts)) {
        const uDoc = await db.collection('users').doc(id).get();
        const name = uDoc.exists ? uDoc.data()?.displayName : 'Unknown User';
        
        // Check if this user reports to Zubair
        const relSnap = await db.collection('reporting_relationships')
            .where('subordinateId', '==', id)
            .where('managerId', '==', userId)
            .get();
        
        const legacyManager = (await db.collection('users').doc(id).get()).data()?.managerId;
        const isSubordinate = !relSnap.empty || legacyManager === userId;

        console.log(`- ${name} (${id}): ${count} tasks (Is direct subordinate in DB: ${isSubordinate})`);
    }

    if (noAssigneeIds.length > 0) {
        console.log(`\nTasks with NO assignee: ${noAssigneeIds.length}`);
    }

    // 4. Detailed Task Audit
    console.log('\n--- Step 3: Comprehensive Task Audit (Total 71) ---');
    
    // Get Zubair's reporting tree
    const subordinateIds: string[] = [];
    const visitedTree = new Set<string>();
    visitedTree.add(userId);
    let currentLevelTree = [userId];
    while (currentLevelTree.length > 0) {
        const nextLevelTree: string[] = [];
        for (const mId of currentLevelTree) {
            const rels = await db.collection('reporting_relationships').where('managerId', '==', mId).get();
            rels.docs.forEach(d => {
                const sId = d.data().subordinateId;
                if (sId && !visitedTree.has(sId)) {
                    visitedTree.add(sId);
                    subordinateIds.push(sId);
                    nextLevelTree.push(sId);
                }
            });
            const legacy = await db.collection('users').where('managerId', '==', mId).get();
            legacy.docs.forEach(d => {
                if (!visitedTree.has(d.id)) {
                    visitedTree.add(d.id);
                    subordinateIds.push(d.id);
                    nextLevelTree.push(d.id);
                }
            });
        }
        currentLevelTree = nextLevelTree;
    }

    console.log(`Zubair's Subordinate Count: ${subordinateIds.length}`);
    
    let inViewCountAudit = 0;
    let outOfViewCountAudit = 0;
    const reasonsAudit = {
        not_subordinate: 0,
        no_assignee: 0,
        self_task: 0
    };

    const outOfViewAssigneesAudit = new Map();

    for (const doc of allTasksSnap.docs) {
        const data = doc.data();
        const assigneeId = data.assigneeId;
        const participants = data.workflowParticipantIds || [];
        
        const isSubordinateAssignee = assigneeId && subordinateIds.includes(assigneeId);
        const hasSubordinateParticipant = participants.some((p: string) => subordinateIds.includes(p));
        
        const isVisible = isSubordinateAssignee || hasSubordinateParticipant;

        if (isVisible) {
            inViewCountAudit++;
        } else {
            outOfViewCountAudit++;
            if (assigneeId === userId) {
                reasonsAudit.self_task++;
            } else if (!assigneeId) {
                reasonsAudit.no_assignee++;
            } else {
                reasonsAudit.not_subordinate++;
                outOfViewAssigneesAudit.set(assigneeId, (outOfViewAssigneesAudit.get(assigneeId) || 0) + 1);
            }
        }
    }

    console.log(`\nTasks in Team View: ${inViewCountAudit}`);
    console.log(`Tasks OUT of Team View: ${outOfViewCountAudit}`);
    console.log(`- Tasks assigned to Zubair himself (excluded by API): ${reasonsAudit.self_task}`);
    console.log(`- Tasks with NO assignee: ${reasonsAudit.no_assignee}`);
    console.log(`- Tasks assigned to people outside hierarchy: ${reasonsAudit.not_subordinate}`);

    console.log('\nPeople outside Zubair\'s hierarchy with tasks:');
    for (const [aId, count] of outOfViewAssigneesAudit.entries()) {
        const u = await db.collection('users').doc(aId).get();
        console.log(`- ${u.data()?.displayName || 'Unknown'} (${aId}): ${count} tasks`);
    }

    // 5. Admin Status
    console.log('\n--- Step 4: Final Status Check ---');
    console.log(`Zubair Admin: ${userDoc.data()?.isAdmin || 'No'}`);
    console.log(`Zubair Role: ${userDoc.data()?.role || 'None'}`);

    process.exit(0);
}

diagnoseZubairTasks().catch(console.error);
