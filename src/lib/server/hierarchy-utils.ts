/**
 * Hierarchy Utilities (Server-side)
 *
 * Provides functions to check manager-subordinate relationships
 * by walking the reporting_relationships collection.
 */

import { getDb } from '@/lib/server/firebase-admin';
import { getValidatorChain } from '@/lib/server/hierarchy';

/**
 * Check if `managerId` is above `subordinateId` in the hierarchy.
 * Delegates to the shared chain resolver in ./hierarchy so the read path
 * and the validator chain use one implementation.
 *
 * Max depth of 20 prevents infinite loops in corrupted data.
 */
export async function isManagerAbove(
  managerId: string,
  subordinateId: string,
  maxDepth: number = 20
): Promise<boolean> {
  if (!managerId || !subordinateId) return false;
  if (managerId === subordinateId) return false;

  try {
    const { chain } = await getValidatorChain(subordinateId, { maxDepth });
    return chain.some((link) => link.uid === managerId);
  } catch (e) {
    console.error('[hierarchy-utils] Error walking hierarchy:', e);
    return false;
  }
}

/**
 * Get all direct subordinates of a manager.
 * Returns array of user IDs that directly report to the given managerId.
 */
export async function getDirectSubordinates(managerId: string): Promise<string[]> {
  const db = getDb();
  if (!db || !managerId) return [];

  try {
    const snapshot = await db.collection('reporting_relationships')
      .where('managerId', '==', managerId)
      .get();

    const subordinateIds = snapshot.docs.map(doc => doc.data().subordinateId).filter(Boolean);

    // Also check legacy managerId field
    const usersSnapshot = await db.collection('users')
      .where('managerId', '==', managerId)
      .get();

    const legacyIds = usersSnapshot.docs.map(doc => doc.id);

    // Merge and deduplicate
    return [...new Set([...subordinateIds, ...legacyIds])];
  } catch (e) {
    console.error('[hierarchy-utils] Error getting subordinates:', e);
    return [];
  }
}

/**
 * Get ALL subordinates (recursive) below a manager in the hierarchy.
 * Walks DOWN the tree. Returns flat array of all user IDs under this manager.
 * Max depth of 10 prevents runaway recursion.
 */
export async function getAllSubordinates(
  managerId: string,
  maxDepth: number = 10
): Promise<string[]> {
  const db = getDb();
  if (!db || !managerId) return [];

  const allSubordinates: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [managerId];
  let depth = 0;

  while (queue.length > 0 && depth < maxDepth) {
    const currentBatch = [...queue];
    queue.length = 0;
    depth++;

    for (const currentId of currentBatch) {
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const directSubs = await getDirectSubordinates(currentId);
      for (const subId of directSubs) {
        if (!visited.has(subId)) {
          allSubordinates.push(subId);
          queue.push(subId);
        }
      }
    }
  }

  return allSubordinates;
}
