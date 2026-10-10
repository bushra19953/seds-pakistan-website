/**
 * Hierarchy Chain Resolution (Server-side)
 *
 * Single source of truth for walking the organizational reporting chain.
 * The hierarchy is the graph managed at /admin/hierarchy, stored in the
 * `reporting_relationships` Firestore collection as subordinateId -> managerId
 * mappings (type 'direct' | 'dotted'), with the legacy `users/{uid}.managerId`
 * field as fallback. The collection has no client Firestore rules
 * (default-deny), so all reads here go through the Admin SDK.
 *
 * Nothing in this module derives seniority from role rank. Roles are only
 * used by callers for permission gates, never for chain resolution.
 */

import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

export interface ChainLink {
  uid: string;
  depth: number;
  type: 'direct' | 'dotted' | 'legacy';
  userExists: boolean;
}

export interface ValidatorChainResult {
  submitterUid: string;
  chain: ChainLink[];
}

export interface TaskLike {
  assignerId?: string;
  assigneeId?: string;
  assigneeIds?: string[];
  submittedBy?: string;
  status?: string;
}

export type ValidationVia = 'chain' | 'assigner' | 'role';

export interface ValidationCheck {
  allowed: boolean;
  reason: string;
  via?: ValidationVia;
  depth?: number | null;
}

const DEFAULT_MAX_DEPTH = 20;

function getDbOrThrow(): FirebaseFirestore.Firestore {
  const db = getDb();
  if (!db) throw new Error('[hierarchy] Firestore not initialized');
  return db;
}

/**
 * Resolve the ordered chain of managers above a user, nearest first.
 * Walks up via reporting_relationships docs, then the legacy user-doc
 * managerId field only when no collection docs exist at that hop.
 * Throws on invalid input or DB failure; an empty chain unambiguously
 * means "no one above this user".
 */
export async function getValidatorChain(
  submitterUid: string,
  options?: { maxDepth?: number }
): Promise<ValidatorChainResult> {
  if (!submitterUid || typeof submitterUid !== 'string') {
    throw new TypeError('[hierarchy] submitterUid must be a non-empty string');
  }
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) {
    throw new RangeError('[hierarchy] maxDepth must be an integer between 1 and 100');
  }

  const db = getDbOrThrow();
  const chain: ChainLink[] = [];
  const visited = new Set<string>([submitterUid]);

  // BFS level by level so depth is exact and nearer managers come first.
  let frontier: string[] = [submitterUid];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    depth++;
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      // 1. Collection relationships first (direct before dotted).
      const snapshot = await db
        .collection('reporting_relationships')
        .where('subordinateId', '==', currentId)
        .get();

      const managers: { uid: string; type: 'direct' | 'dotted' }[] = [];
      for (const doc of snapshot.docs) {
        const rel = doc.data();
        const managerId = typeof rel.managerId === 'string' ? rel.managerId : '';
        if (!managerId || visited.has(managerId)) continue;
        managers.push({
          uid: managerId,
          type: rel.type === 'dotted' ? 'dotted' : 'direct',
        });
      }
      managers.sort((a, b) =>
        a.type === b.type ? 0 : a.type === 'direct' ? -1 : 1
      );

      for (const m of managers) {
        visited.add(m.uid);
        const userDoc = await db.collection('users').doc(m.uid).get();
        chain.push({ uid: m.uid, depth, type: m.type, userExists: userDoc.exists });
        nextFrontier.push(m.uid);
      }

      // 2. Legacy fallback only when the collection had nothing at this hop.
      if (managers.length === 0) {
        const userDoc = await db.collection('users').doc(currentId).get();
        const legacyManagerId = userDoc.exists
          ? userDoc.data()?.managerId
          : undefined;
        if (typeof legacyManagerId === 'string' && legacyManagerId && !visited.has(legacyManagerId)) {
          visited.add(legacyManagerId);
          const mgrDoc = await db.collection('users').doc(legacyManagerId).get();
          chain.push({ uid: legacyManagerId, depth, type: 'legacy', userExists: mgrDoc.exists });
          nextFrontier.push(legacyManagerId);
        }
      }
    }

    frontier = nextFrontier;
  }

  return { submitterUid, chain };
}

/**
 * Thin wrapper returning just the ordered uid list, nearest first.
 */
export async function getValidatorChainUids(submitterUid: string): Promise<string[]> {
  const result = await getValidatorChain(submitterUid);
  return result.chain.map((link) => link.uid);
}

/**
 * DAG cycle detection for the reporting graph.
 * DFS upward from the proposed manager through both the collection and the
 * legacy field. Hoisted here from the hierarchy relationships route so the
 * write path and read path share one implementation.
 */
export async function wouldCreateCycle(
  subordinateId: string,
  managerId: string
): Promise<{ hasCycle: boolean; path?: string[] }> {
  if (!subordinateId || !managerId) {
    throw new TypeError('[hierarchy] subordinateId and managerId are required');
  }
  if (subordinateId === managerId) {
    return { hasCycle: true, path: [subordinateId, managerId] };
  }

  const db = getDbOrThrow();
  const visited = new Set<string>();
  const stack: { id: string; path: string[] }[] = [{ id: managerId, path: [managerId] }];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current.id === subordinateId) {
      return { hasCycle: true, path: [...current.path, subordinateId] };
    }
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    const managersSnapshot = await db
      .collection('reporting_relationships')
      .where('subordinateId', '==', current.id)
      .get();
    for (const doc of managersSnapshot.docs) {
      const relManagerId = doc.data()?.managerId;
      if (typeof relManagerId === 'string' && relManagerId && !visited.has(relManagerId)) {
        stack.push({ id: relManagerId, path: [...current.path, relManagerId] });
      }
    }

    const userDoc = await db.collection('users').doc(current.id).get();
    const legacyManagerId = userDoc.exists ? userDoc.data()?.managerId : undefined;
    if (typeof legacyManagerId === 'string' && legacyManagerId && !visited.has(legacyManagerId)) {
      stack.push({ id: legacyManagerId, path: [...current.path, legacyManagerId] });
    }
  }

  return { hasCycle: false };
}

export interface DirectRelationshipSyncResult {
  upserted: boolean;
  removedStale: number;
}

/**
 * Mirror a legacy `users/{uid}.managerId` write into the canonical
 * `reporting_relationships` collection so the two stores cannot drift.
 *
 * - If `newManagerId` is set, upserts a deterministic
 *   `${subordinateId}_${managerId}` doc (`type: 'direct'`) for the pair.
 *   An existing edge for the same pair (e.g. created from the canvas) is
 *   reused instead of duplicated.
 * - Deletes stale edges for the subordinate whose manager no longer matches,
 *   so a move leaves no ghost edges. `dotted` edges are untouched because the
 *   legacy field only represents the direct manager.
 * - If `newManagerId` is null, every direct edge for the subordinate is removed.
 */
export async function syncDirectRelationship(
  subordinateId: string,
  newManagerId: string | null,
  createdBy: string
): Promise<DirectRelationshipSyncResult> {
  if (!subordinateId) {
    throw new TypeError('[hierarchy] subordinateId is required');
  }

  const db = getDbOrThrow();
  const relationships = db.collection('reporting_relationships');
  const existing = await relationships.where('subordinateId', '==', subordinateId).get();

  const batch = db.batch();
  let removedStale = 0;
  let edgeExists = false;

  for (const doc of existing.docs) {
    const data = doc.data();
    const docManagerId = data?.managerId;
    const docType = data?.type;

    // Dotted edges are independent of the legacy managerId field; keep them.
    if (docType === 'dotted') continue;

    if (newManagerId && docManagerId === newManagerId) {
      edgeExists = true;
      continue;
    }
    batch.delete(doc.ref);
    removedStale++;
  }

  let upserted = false;
  if (newManagerId && !edgeExists) {
    const relRef = relationships.doc(`${subordinateId}_${newManagerId}`);
    batch.set(
      relRef,
      {
        subordinateId,
        managerId: newManagerId,
        type: 'direct',
        createdAt: new Date(),
        createdBy,
      },
      { merge: true }
    );
    upserted = true;
  }

  await batch.commit();
  return { upserted, removedStale };
}

/**
 * Decide whether a caller may validate (approve/reject) a task.
 * Deny-first order:
 *  1. Self-approval is always denied when the submitter is known.
 *  2. Anyone above the submitter in the reporting chain may validate.
 *  3. The original assigner may validate (backwards compat).
 *  4. Holders of canManageTasks may validate (backwards compat).
 * For legacy tasks without submittedBy, the chain is checked against every
 * assignee, matching the previous isManagerAbove behavior.
 */
export async function canValidateTask(
  callerUid: string,
  callerRole: string,
  task: TaskLike
): Promise<ValidationCheck> {
  if (!callerUid) {
    return { allowed: false, reason: 'missing caller identity' };
  }

  const submittedBy =
    typeof task.submittedBy === 'string' && task.submittedBy ? task.submittedBy : undefined;

  // 1. No one validates their own submission.
  if (submittedBy && callerUid === submittedBy) {
    return { allowed: false, reason: 'cannot validate own submission' };
  }

  const assigneeIds: string[] = Array.isArray(task.assigneeIds) && task.assigneeIds.length
    ? task.assigneeIds.map(String).filter(Boolean)
    : task.assigneeId
      ? [String(task.assigneeId)]
      : [];

  // 2. Chain above the submitter (or every assignee for legacy tasks).
  const chainTargets = submittedBy ? [submittedBy] : assigneeIds;
  for (const target of chainTargets) {
    if (!target || target === callerUid) continue;
    const chain = await getValidatorChain(target);
    const link = chain.chain.find((l) => l.uid === callerUid);
    if (link) {
      return {
        allowed: true,
        reason: 'caller is above the submitter in the reporting chain',
        via: 'chain',
        depth: link.depth,
      };
    }
  }

  // 3. Original assigner keeps their existing right.
  if (task.assignerId && callerUid === String(task.assignerId)) {
    // Close the self-approval hole for legacy tasks: an assigner who is also
    // the doer cannot approve when no one else could validate instead.
    const isAlsoAssignee = assigneeIds.includes(callerUid);
    if (!submittedBy && isAlsoAssignee && chainTargets.length > 0) {
      try {
        const chain = await getValidatorChain(chainTargets[0]);
        if (chain.chain.length === 0) {
          return { allowed: true, reason: 'assigner with no one above in chain', via: 'assigner', depth: null };
        }
      } catch {
        // Fall through to the deny below on infra failure.
      }
      return { allowed: false, reason: 'assigner cannot validate own work when validators exist above' };
    }
    return { allowed: true, reason: 'caller is the original assigner', via: 'assigner', depth: null };
  }

  // 4. Role-based managers keep their existing right.
  try {
    if (await hasServerPermission(callerRole, 'canManageTasks')) {
      return { allowed: true, reason: 'caller holds canManageTasks', via: 'role', depth: null };
    }
  } catch (e) {
    console.error('[hierarchy] permission check failed:', e);
  }

  return { allowed: false, reason: 'caller is not above the submitter, not the assigner, and lacks canManageTasks' };
}

/**
 * Resolve a user's display name for notifications and audit entries.
 * Never throws; falls back to a short uid label.
 */
export async function resolveDisplayName(uid: string): Promise<string> {
  try {
    const db = getDb();
    if (!db || !uid) return 'Team Member';
    const snap = await db.collection('users').doc(uid).get();
    const data = snap.exists ? snap.data() : undefined;
    return data?.displayName || data?.email || 'Team Member';
  } catch {
    return 'Team Member';
  }
}
