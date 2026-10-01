/**
 * Hierarchy Utilities (Server-side)
 *
 * Provides functions to check manager-subordinate relationships
 * by walking the reporting_relationships collection.
 */

import { getDb } from '@/lib/server/firebase-admin';

/**
 * Check if `managerId` is above `subordinateId` in the hierarchy.
 * Walks UP from the subordinate through their managers using BFS.
 * Returns true if managerId is found anywhere above subordinateId.
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

  const db = getDb();
  if (!db) return false;

  const visited = new Set<string>();
  const queue: string[] = [subordinateId];
  let depth = 0;

  while (queue.length > 0 && depth < maxDepth) {
    const currentBatch = [...queue];
    queue.length = 0;
    depth++;

    for (const currentId of currentBatch) {
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      // Find all managers of this user
      try {
        const snapshot = await db.collection('reporting_relationships')
          .where('subordinateId', '==', currentId)
          .get();

        for (const doc of snapshot.docs) {
          const rel = doc.data();
          if (rel.managerId === managerId) {
            return true; // Found! managerId is above subordinateId
          }
          if (rel.managerId && !visited.has(rel.managerId)) {
            queue.push(rel.managerId);
          }
        }

        // Also check legacy managerId field on user doc
        const userDoc = await db.collection('users').doc(currentId).get();
        if (userDoc.exists) {
          const legacyManagerId = userDoc.data()?.managerId;
          if (legacyManagerId === managerId) {
            return true;
          }
          if (legacyManagerId && !visited.has(legacyManagerId)) {
            queue.push(legacyManagerId);
          }
        }
      } catch (e) {
        console.error('[hierarchy-utils] Error walking hierarchy:', e);
      }
    }
  }

  return false;
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
