/**
 * Fix Zero-Point Workflow Tasks
 * Retroactively assigns points to workflow tasks that were created with 0 points
 * 
 * Usage:
 *   DRY RUN:  npx ts-node scripts/fix-zero-point-tasks.ts --dry-run
 *   EXECUTE:  npx ts-node scripts/fix-zero-point-tasks.ts
 */

import { initializeApp, cert, ServiceAccount } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const BASE_POINTS = 10;

// Initialize Firebase Admin
const serviceAccountPath = path.resolve(__dirname, '../seds-pakistan-service-account.json');
try {
    const serviceAccount = require(serviceAccountPath);
    initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
    console.error('❌ Failed to load service account. Ensure service-account.json exists in project root.');
    process.exit(1);
}

const db = getFirestore();

async function fixZeroPointTasks() {
    console.log('🔧 Fix Zero-Point Workflow Tasks');
    console.log('=================================');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '⚡ LIVE (will update documents)'}`);
    console.log('');

    // Find all tasks with 0 points (or no points) that are workflow tasks
    const tasksSnap = await db.collection('tasks')
        .where('points', '==', 0)
        .get();

    console.log(`📊 Found ${tasksSnap.docs.length} tasks with 0 points\n`);

    let updated = 0;
    let skipped = 0;
    const batch = db.batch();
    const MAX_BATCH_SIZE = 500;
    let batchCount = 0;

    for (const doc of tasksSnap.docs) {
        const data = doc.data();

        // Calculate points based on sequence index (if workflow task) or default
        const sequenceIndex = data.sequenceIndex ?? 0;
        const newPoints = BASE_POINTS + (sequenceIndex * 5);

        // Skip if already completed (don't want to mess with historical data for completed tasks
        // unless you want retroactive points - uncomment below)
        // if (data.status === 'completed') {
        //   skipped++;
        //   continue;
        // }

        if (!DRY_RUN) {
            batch.update(doc.ref, {
                points: newPoints,
                _pointsFixedAt: new Date(),
                _previousPoints: 0
            });
            batchCount++;

            if (batchCount >= MAX_BATCH_SIZE) {
                await batch.commit();
                batchCount = 0;
            }
        }

        console.log(`  ${DRY_RUN ? 'WOULD FIX' : 'FIXED'}: "${data.title}" (step ${sequenceIndex}) → ${newPoints} pts`);
        updated++;
    }

    // Commit remaining batch
    if (!DRY_RUN && batchCount > 0) {
        await batch.commit();
    }

    console.log('\n=================================');
    console.log(`📋 SUMMARY: ${updated} tasks ${DRY_RUN ? 'would be' : ''} updated, ${skipped} skipped`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - No changes were made.');
        console.log('   Run again without --dry-run to apply fixes.');
    } else {
        console.log('\n✅ All zero-point tasks have been fixed!');
    }
}

fixZeroPointTasks()
    .then(() => {
        console.log('\n🎉 Script completed successfully.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n❌ Script failed:', err);
        process.exit(1);
    });
