/**
 * Retroactive Data Repair Script
 * Recalculates all user aggregates (points, hours, task counts) from task history
 * 
 * Usage:
 *   DRY RUN:  npx ts-node scripts/recalculate-user-aggregates.ts --dry-run
 *   EXECUTE:  npx ts-node scripts/recalculate-user-aggregates.ts
 */

import { initializeApp, cert, ServiceAccount } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import * as path from 'path';

// Parse CLI args
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const SINGLE_USER = process.argv.find(a => a.startsWith('--user='))?.split('=')[1];

// Initialize Firebase Admin
const serviceAccountPath = path.resolve(__dirname, '../seds-pakistan-service-account.json');
try {
    const serviceAccount = require(serviceAccountPath);
    initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
    console.error('❌ Failed to load service account. Ensure service-account.json exists in project root.');
    console.error('   Download from Firebase Console > Project Settings > Service Accounts');
    process.exit(1);
}

const db = getFirestore();

interface UserAggregate {
    points: number;
    totalHoursWorked: number;
    tasksCompletedCount: number;
    tasksCompletedOnTimeCount: number;
    tasksAssignedCount: number;
}

interface DiscrepancyReport {
    userId: string;
    displayName: string;
    field: string;
    stored: number;
    calculated: number;
    diff: number;
}

async function recalculateUserAggregates() {
    console.log('🔧 SEDS Portal - Retroactive Data Repair Script');
    console.log('================================================');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '⚡ LIVE (will update documents)'}`);
    console.log('');

    const discrepancies: DiscrepancyReport[] = [];
    let usersProcessed = 0;
    let usersWithIssues = 0;

    // Get users to process
    let usersQuery = db.collection('users');
    if (SINGLE_USER) {
        console.log(`📌 Processing single user: ${SINGLE_USER}`);
    }

    const usersSnap = SINGLE_USER
        ? await db.collection('users').doc(SINGLE_USER).get().then(d => ({ docs: d.exists ? [d] : [] }))
        : await usersQuery.get();

    console.log(`📊 Found ${usersSnap.docs.length} users to process\n`);

    for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        const userData = userDoc.data();
        const displayName = userData?.displayName || userData?.email || userId;

        // Get all tasks where this user is the assignee
        const tasksSnap = await db.collection('tasks')
            .where('assigneeId', '==', userId)
            .get();

        // Also check assigneeIds array (for multi-assignee tasks)
        const multiAssigneeTasks = await db.collection('tasks')
            .where('assigneeIds', 'array-contains', userId)
            .get();

        // Merge and deduplicate
        const allTaskDocs = new Map();
        tasksSnap.docs.forEach(d => allTaskDocs.set(d.id, d));
        multiAssigneeTasks.docs.forEach(d => allTaskDocs.set(d.id, d));

        let calculatedPoints = 0;
        let calculatedHours = 0;
        let completedCount = 0;
        let onTimeCount = 0;
        let assignedCount = allTaskDocs.size;

        allTaskDocs.forEach((taskDoc) => {
            const task = taskDoc.data();

            // Only count completed tasks for points/hours
            if (task.status === 'completed') {
                calculatedPoints += task.points || 0;
                calculatedHours += task.hoursWorked || 0;
                completedCount += 1;

                // Check on-time completion
                const completedAt = task.completedAt?.toDate?.() || (task.completedAt ? new Date(task.completedAt) : null);
                const deadline = task.deadline?.toDate?.() || task.individualDeadline?.toDate?.() ||
                    (task.deadline ? new Date(task.deadline) : null);

                if (completedAt && deadline && completedAt <= deadline) {
                    onTimeCount += 1;
                }
            }
        });

        const calculated: UserAggregate = {
            points: calculatedPoints,
            totalHoursWorked: calculatedHours,
            tasksCompletedCount: completedCount,
            tasksCompletedOnTimeCount: onTimeCount,
            tasksAssignedCount: assignedCount,
        };

        const stored: UserAggregate = {
            points: userData?.points || 0,
            totalHoursWorked: userData?.totalHoursWorked || 0,
            tasksCompletedCount: userData?.tasksCompletedCount || 0,
            tasksCompletedOnTimeCount: userData?.tasksCompletedOnTimeCount || 0,
            tasksAssignedCount: userData?.tasksAssignedCount || 0,
        };

        // Check for discrepancies
        const fields: (keyof UserAggregate)[] = ['points', 'totalHoursWorked', 'tasksCompletedCount', 'tasksCompletedOnTimeCount', 'tasksAssignedCount'];
        let hasDiscrepancy = false;

        for (const field of fields) {
            if (stored[field] !== calculated[field]) {
                hasDiscrepancy = true;
                discrepancies.push({
                    userId,
                    displayName,
                    field,
                    stored: stored[field],
                    calculated: calculated[field],
                    diff: calculated[field] - stored[field],
                });
            }
        }

        if (hasDiscrepancy) {
            usersWithIssues++;

            if (VERBOSE) {
                console.log(`❗ ${displayName} (${userId}):`);
                console.log(`   Points: ${stored.points} → ${calculated.points}`);
                console.log(`   Hours: ${stored.totalHoursWorked} → ${calculated.totalHoursWorked}`);
                console.log(`   Completed: ${stored.tasksCompletedCount} → ${calculated.tasksCompletedCount}`);
                console.log(`   On-time: ${stored.tasksCompletedOnTimeCount} → ${calculated.tasksCompletedOnTimeCount}`);
                console.log(`   Assigned: ${stored.tasksAssignedCount} → ${calculated.tasksAssignedCount}`);
            }

            if (!DRY_RUN) {
                await db.collection('users').doc(userId).update({
                    points: calculated.points,
                    totalHoursWorked: calculated.totalHoursWorked,
                    tasksCompletedCount: calculated.tasksCompletedCount,
                    tasksCompletedOnTimeCount: calculated.tasksCompletedOnTimeCount,
                    tasksAssignedCount: calculated.tasksAssignedCount,
                    lastAggregateRecalc: new Date(),
                    aggregateRecalcSource: 'retroactive-script-v1',
                });
            }
        }

        usersProcessed++;
        if (usersProcessed % 50 === 0) {
            console.log(`   Processed ${usersProcessed}/${usersSnap.docs.length} users...`);
        }
    }

    // Summary
    console.log('\n================================================');
    console.log('📋 SUMMARY');
    console.log('================================================');
    console.log(`Total users processed: ${usersProcessed}`);
    console.log(`Users with discrepancies: ${usersWithIssues}`);
    console.log(`Total discrepancies found: ${discrepancies.length}`);

    if (discrepancies.length > 0) {
        console.log('\n📊 Discrepancy Breakdown:');
        const byField = discrepancies.reduce((acc, d) => {
            acc[d.field] = (acc[d.field] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        Object.entries(byField).forEach(([field, count]) => {
            console.log(`   ${field}: ${count} users affected`);
        });

        // Show top 5 biggest point discrepancies
        const pointDiscreps = discrepancies.filter(d => d.field === 'points').sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
        if (pointDiscreps.length > 0) {
            console.log('\n🏆 Top Point Discrepancies:');
            pointDiscreps.slice(0, 5).forEach(d => {
                console.log(`   ${d.displayName}: ${d.stored} → ${d.calculated} (${d.diff > 0 ? '+' : ''}${d.diff})`);
            });
        }
    }

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - No changes were made.');
        console.log('   Run again without --dry-run to apply fixes.');
    } else {
        console.log('\n✅ All discrepancies have been corrected!');
    }
}

// Run
recalculateUserAggregates()
    .then(() => {
        console.log('\n🎉 Script completed successfully.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n❌ Script failed:', err);
        process.exit(1);
    });
