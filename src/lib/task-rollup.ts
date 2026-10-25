import { getDb } from '@/lib/server/firebase-admin';
import { isTerminalTaskStatus } from './workflow-progress';

/**
 * Recalculates the roll-up progress for a parent task based on its sub-tasks.
 * Should be called whenever a sub-task's status changes.
 * 
 * @param parentTaskId - The ID of the parent task to update
 */
export async function recalculateTaskRollup(parentTaskId: string): Promise<void> {
    const db = getDb();
    if (!db || !parentTaskId) return;

    try {
        // Get all sub-tasks for this parent
        const subTasksSnapshot = await db.collection('tasks')
            .where('parentTaskId', '==', parentTaskId)
            .get();

        const subTaskCount = subTasksSnapshot.size;
        // Terminal = canonical 'completed' OR legacy 'approved' (older
        // approval paths stamped both spellings; readers honor both).
        const completedCount = subTasksSnapshot.docs.filter(doc =>
            isTerminalTaskStatus(doc.data().status)
        ).length;

        // Update parent task with roll-up counts
        await db.collection('tasks').doc(parentTaskId).update({
            subTaskCount,
            subTaskCompletedCount: completedCount,
            updatedAt: new Date()
        });

        console.log(`[RollUp] Updated parent ${parentTaskId}: ${completedCount}/${subTaskCount} complete`);

    } catch (error) {
        console.error('[RollUp] Failed to update parent task:', error);
    }
}

/**
 * Get roll-up percentage for a task
 */
export function calculateRollupPercentage(subTaskCount?: number, subTaskCompletedCount?: number): number {
    if (!subTaskCount || subTaskCount === 0) return 0;
    return Math.round((subTaskCompletedCount || 0) / subTaskCount * 100);
}
