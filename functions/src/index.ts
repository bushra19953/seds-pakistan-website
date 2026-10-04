import type { App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';

// Lazy-initialize Admin SDK and Firestore to avoid analyzer timeouts during deploy.
let adminApp: App | undefined;
let db: Firestore | undefined;
let authSvc: Auth | undefined;
let messagingSvc: Messaging | undefined;

function getAdminApp(): App {
  if (!adminApp) {
    const { getApps, initializeApp } = require('firebase-admin/app');
    // Lazy initialization only when needed
    adminApp = getApps().length ? (getApps()[0] as App) : initializeApp();
  }
  return adminApp!;
}

function getDb(): Firestore {
  if (!db) {
    const { getFirestore } = require('firebase-admin/firestore');
    db = getFirestore(getAdminApp());
    logger.log('✅ Firestore initialized');
  }
  return db!;
}

function getAdminAuth(): Auth {
  if (!authSvc) {
    const { getAuth } = require('firebase-admin/auth');
    authSvc = getAuth(getAdminApp());
    logger.log('✅ Auth initialized');
  }
  return authSvc!;
}

function getMessagingSvc(): Messaging {
  if (!messagingSvc) {
    const { getMessaging } = require('firebase-admin/messaging');
    messagingSvc = getMessaging(getAdminApp());
    logger.log('✅ Messaging initialized');
  }
  return messagingSvc!;
}


// 📋 [CONSOLIDATED TRIGGER] Unified Task Management
// This single trigger handles creation, updates, and universal submission sync for tasks
export const onTaskWritten = onDocumentWritten({ 
  document: 'tasks/{taskId}', 
  memory: '256MiB',
  cpu: 0.125, // Minimum CPU to reduce quota footprint
  maxInstances: 5
}, async (event) => {
  const db = getDb();
  const taskId = event.params.taskId;
  const before = event.data?.before.exists ? event.data.before.data() as any : null;
  const after = event.data?.after.exists ? event.data.after.data() as any : null;

  // 1. Handle Deletion
  if (!after) {
    logger.log('🗑️ [TASK] Deletion detected:', taskId);
    const userId = before?.userId || before?.assigneeId || (Array.isArray(before?.assigneeIds) ? before.assigneeIds[0] : null);
    if (userId) {
      await db.collection('users').doc(userId).collection('activity').add({
        type: 'taskDeleted',
        taskId,
        taskTitle: before?.title || 'Untitled',
        deletedAt: new Date(),
      });
    }
    // Sync to universal_submissions
    await db.collection('universal_submissions').doc(`tasks_${taskId}`).delete();
    return;
  }

  // 2. Handle Creation
  if (!before) {
    logger.log('✨ [TASK] Creation detected:', taskId);
    const creatorId = after.userId || after.createdBy || after.assigneeId;
    if (creatorId) {
      await db.collection('users').doc(creatorId).collection('activity').add({
        type: 'taskCreated',
        taskId,
        taskTitle: after.title,
        createdAt: new Date(),
      });
    }

    // Notify all assignees
    const assigneeIds: string[] = Array.isArray(after.assigneeIds)
      ? after.assigneeIds.filter((id: any) => typeof id === 'string' && id.length > 0)
      : (typeof after.assigneeId === 'string' && after.assigneeId ? [after.assigneeId] : []);

    if (assigneeIds.length > 0) {
      const now = new Date();
      const batch = db.batch();
      for (const uid of assigneeIds) {
        const notifRef = db.collection('users').doc(uid).collection('notifications').doc();
        batch.set(notifRef, {
          userId: uid,
          type: 'task-assigned',
          title: 'New Task Assigned',
          body: `You have been assigned a new task: "${after.title}"`,
          taskId,
          createdAt: now,
          isRead: false,
          priority: 'P1',
          link: `/tasks/${taskId}`,
        });
      }
      await batch.commit();
    }
  }

  // 3. Handle Updates (Reward logic)
  if (before && after) {
    const wasCompleted = before.status === 'completed';
    const isCompleted = after.status === 'completed';
    if (isCompleted && !wasCompleted) {
      try {
        const taskRef = db.collection('tasks').doc(taskId);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(taskRef);
          const t = snap.data() as any;
          if (t && t.rewardApplied === true) return;
          
          const points = typeof t?.points === 'number' && t.points > 0 ? t.points : 0;
          const hoursWorked = typeof t?.hoursWorked === 'number' && t.hoursWorked > 0 ? t.hoursWorked : 0;
          const badgeId = typeof t?.completionBadgeId === 'string' && t.completionBadgeId ? t.completionBadgeId : null;
          const assigneeIds: string[] = Array.isArray(t?.assigneeIds) ? t.assigneeIds.filter((x: any) => typeof x === 'string') : (typeof t?.assigneeId === 'string' && t.assigneeId ? [t.assigneeId] : []);
          const now = new Date();
          const d: any = t?.deadline;
          let deadlineDate: Date | null = null;
          if (d && typeof d?.toDate === 'function') deadlineDate = d.toDate(); else if (d instanceof Date) deadlineDate = d;
          const onTime = !!(deadlineDate && now.getTime() <= deadlineDate.getTime());
          
          for (const uid of assigneeIds) {
            const userRef = db.collection('users').doc(uid);
            tx.update(userRef, {
              points: require('firebase-admin/firestore').FieldValue.increment(points),
              totalHoursWorked: require('firebase-admin/firestore').FieldValue.increment(hoursWorked),
              tasksCompletedCount: require('firebase-admin/firestore').FieldValue.increment(1),
              tasksCompletedOnTimeCount: require('firebase-admin/firestore').FieldValue.increment(onTime ? 1 : 0),
              lastTaskCompletedAt: now,
            });
            if (badgeId) tx.update(userRef, { badges: require('firebase-admin/firestore').FieldValue.arrayUnion(badgeId) });
            const ledgerRef = userRef.collection('rewards').doc(taskId);
            tx.set(ledgerRef, { taskId, pointsAwarded: points, hoursAwarded: hoursWorked, badgeId, createdAt: now, onTime }, { merge: true });
            const notifRef = userRef.collection('notifications').doc();
            tx.set(notifRef, { userId: uid, type: 'task-complete', title: '🏆 Task Completed!', body: `You completed "${t.title}" and earned ${points} points!`, taskId, points, hoursWorked, badgeId, createdAt: now, read: false, priority: 'P2', link: `/tasks/${taskId}` });
          }
          tx.update(taskRef, { rewardApplied: true, completedAt: now, updatedAt: now });
        });
      } catch (e) {
        logger.error('Transactional awarding failed', { taskId, error: e });
      }
    }
    
    // Add update activity
    const userId = after.userId || after.assigneeId || (Array.isArray(after.assigneeIds) ? after.assigneeIds[0] : null);
    if (userId) {
      await db.collection('users').doc(userId).collection('activity').add({ type: 'taskUpdated', taskId, taskTitle: after.title, updatedAt: new Date() });
    }
  }

  // 4. Handle Universal Submission Sync (Always run if not deleted)
  await handleUniversalSubmissionSync(
    event,
    'tasks',
    'TASK_REVIEW',
    (d) => `Task Review: ${d.title || d.name || 'Task Completion'}`,
    (d) => d.assigneeId || d.userId || (Array.isArray(d.assigneeIds) ? d.assigneeIds[0] : null),
    (d) => {
      const s = String(d.status || '').toUpperCase();
      return (s === 'PENDING_REVIEW') ? 'PENDING' : s;
    }
  );
});

// 👤 [CONSOLIDATED TRIGGER] Unified User Management
// Handles badge awarding, leaderboard cache invalidation, and email sync
export const onUserWritten = onDocumentWritten({
  document: 'users/{userId}',
  memory: '256MiB',
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  const db = getDb();
  const userId = event.params.userId;
  const before = event.data?.before.exists ? event.data.before.data() : null;
  const after = event.data?.after.exists ? event.data.after.data() : null;

  if (!after) {
    logger.log('🗑️ [USER] Deletion detected:', userId);
    return;
  }

  // 1. Badge Awarding (If points increased)
  if (before && after) {
    const beforePoints = Number(before.points || 0);
    const afterPoints = Number(after.points || 0);
    if (afterPoints > beforePoints) {
      try {
        const snapshot = await db.collection('badges').get();
        const badgeDocs = snapshot.docs.map(d => d.data() as any);
        const owned: string[] = Array.isArray(after.badges) ? after.badges.filter((s: any) => typeof s === 'string') : [];
        const toAward: string[] = badgeDocs
          .filter(b => b?.isActive !== false)
          .filter(b => Number(b?.pointsRequired || 0) <= afterPoints)
          .map(b => String(b?.slug || ''))
          .filter(slug => slug.length > 0 && !owned.includes(slug));

        if (toAward.length > 0) {
          await db.collection('users').doc(userId).update({
            badges: require('firebase-admin/firestore').FieldValue.arrayUnion(...toAward),
            updatedAt: new Date(),
          });
          logger.info(`🏆 [USER] Awarded badges to ${userId}: ${toAward.join(', ')}`);
        }
      } catch (err) {
        logger.error('❌ [USER] Badge awarding failed:', err);
      }
    }
  }

  // 2. Leaderboard Cache Invalidation
  if (before && after) {
    const relevantFields = ['points', 'displayName', 'upvotes', 'downvotes', 'photoURL', 'badges', 'chapterId', 'displayRole'];
    const hasRelevantChanges = relevantFields.some(f => before[f] !== after[f]);
    if (hasRelevantChanges) {
      await db.collection('cache').doc('leaderboard').set({
        lastUpdated: new Date(),
        invalidatedUser: userId,
      }, { merge: true });
      logger.log('🔄 [USER] Cache invalidated:', userId);
    }
  }

  // 3. Email Lowercase Sync
  const email = after.email;
  const emailLowercase = after.email_lowercase;
  if (email && (!emailLowercase || emailLowercase !== email.toLowerCase())) {
    await db.collection('users').doc(userId).update({
      email_lowercase: email.toLowerCase(),
      updatedAt: new Date(),
    });
    logger.log('📧 [USER] email_lowercase synced:', userId);
  }
});

// 🔑 [CONSOLIDATED TRIGGER] Unified Role Management
// Syncs roles to user documents and custom claims simultaneously
export const onRoleWritten = onDocumentWritten({
  document: 'roles/{userId}',
  memory: '256MiB',
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  const auth = getAdminAuth();
  const db = getDb();
  const userId = event.params.userId;
  const after = event.data?.after.exists ? event.data.after.data() as any : null;

  try {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const chapterId = userDoc.exists ? userDoc.data()?.chapterId : null;

    if (after) {
      // Role created or updated
      const newRole = after.role || null;
      
      // Sync to user document
      await userRef.update({ role: newRole, displayRole: newRole, updatedAt: new Date() });
      
      // Sync to custom claims
      const claims: any = {};
      if (newRole) claims.role = String(newRole);
      if (chapterId) claims.chapter_id = String(chapterId);
      await auth.setCustomUserClaims(userId, claims);
      
      logger.info(`✅ [ROLE] Synced role ${newRole} to user and claims: ${userId}`);
    } else {
      // Role deleted: clear both role mirrors so neither store keeps the old value
      await userRef.update({ role: null, displayRole: null, updatedAt: new Date() });
      
      const claims: any = {};
      if (chapterId) claims.chapter_id = String(chapterId);
      await auth.setCustomUserClaims(userId, claims);
      
      logger.info(`🗑️ [ROLE] Cleared role from user and claims: ${userId}`);
    }
  } catch (error) {
    logger.error('❌ [ROLE] Sync failed:', { userId, error });
  }
});

export const onUserChangedSyncClaims = onDocumentWritten({ 
  document: 'users/{userId}', 
  memory: '256MiB', 
  cpu: 0.125,
  maxInstances: 5 
}, async (event) => {
  const auth = getAdminAuth();
  const userId = event.params.userId;
  try {
    const beforeData = event.data?.before.exists ? event.data.before.data() : {};
    const afterData = event.data?.after.exists ? event.data.after.data() : null;

    if (!afterData) return; // User deleted

    const beforeChapter = beforeData?.chapterId;
    const afterChapter = afterData?.chapterId;

    if (beforeChapter !== afterChapter) {
      // chapter change detected
      const userRec = await auth.getUser(userId);
      const currentClaims = userRec.customClaims || {};
      const newClaims = { ...currentClaims };
      if (afterChapter) {
        newClaims.chapter_id = String(afterChapter);
      } else {
        delete newClaims.chapter_id;
      }
      await auth.setCustomUserClaims(userId, newClaims);
      logger.info('[CLAIMS] Syncing user chapter_id to claims', { userId, afterChapter });
    }
  } catch (error) {
    logger.error('[CLAIMS] Failed to sync chapter_id to claims', { userId, error });
  }
});

// ============================================================================
// 💥 V52.0 SWARM DEPLOYED: UNIFIED API ROUTER (SINGLE ENTRY POINT) 💥
// ============================================================================
// ALL HTTP AND CALLABLE FUNCTIONS MUST ROUTE THROUGH THIS SINGLE EXPORT
// TO PREVENT DEPLOYMENT TIMEOUTS AND COLD-START APOCALYPSE.
export const api = onRequest({ memory: '512MiB', cpu: 0.25, maxInstances: 40 }, async (req, res) => {
  const cors = require('cors')({ origin: true });
  
  cors(req, res, async () => {
    try {
      // Normalize path (remove leading/trailing slashes)
      const path = req.path.replace(/^\/+|\/+$/g, '');

      if (path === 'proxyImage') {
        return await handleProxyImage(req, res);
      }
      if (path === 'leaderboardAggregate' || path === 'onLeaderboardAggregate') {
        return await handleLeaderboardAggregate(req, res);
      }
      if (path === 'checkPositionContinuity') {
        return await handleCallableDispatcher(req, res, handleCheckPositionContinuity);
      }
      if (path === 'registerForEvent') {
        return await handleCallableDispatcher(req, res, handleRegisterForEvent);
      }

      
      return res.status(404).json({ error: 'Endpoint not found or not migrated to unified API yet.' });
    } catch (error) {
      logger.error('💥 [API ROUTER] Uncaught Error:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });
});

// Image proxy for user profile pictures to fix CORS issues (Internal Handler)
async function handleProxyImage(req: any, res: any) {
  try {
    const { url, w = '50', h = '50' } = req.query;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'URL parameter is required' });
      return;
    }

    // Only allow Google profile images and other trusted sources
    const allowedDomains = [
      'lh3.googleusercontent.com',
      'lh4.googleusercontent.com',
      'lh5.googleusercontent.com',
      'lh6.googleusercontent.com',
      'googleusercontent.com',
      'firebasestorage.googleapis.com'
    ];

    const isAllowed = allowedDomains.some(domain => url.includes(domain));
    if (!isAllowed) {
      res.status(403).json({ error: 'Domain not allowed' });
      return;
    }

    // Fetch the image
    const imageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEDS-Pakistan-Proxy/1.0)'
      }
    });

    if (!imageResponse.ok) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await imageResponse.arrayBuffer();

    // Set appropriate headers
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.set('Access-Control-Allow-Origin', '*');

    // Send the image
    res.status(200).send(Buffer.from(imageBuffer));

  } catch (error) {
    logger.error('Image proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
}

// 🛡️ Callable-to-HTTP Dispatcher (Simulates onCall behavior for the unified API)
async function handleCallableDispatcher(req: any, res: any, handler: (data: any, auth: any) => Promise<any>) {
  try {
    // 1. Verify Authentication
    const authHeader = req.headers.authorization;
    let auth = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.split('Bearer ')[1];
      try {
        const decodedToken = await getAdminAuth().verifyIdToken(idToken);
        auth = { uid: decodedToken.uid, token: decodedToken };
      } catch (e) {
        logger.warn('⚠️ [API] Invalid token provided to callable route:', req.path);
      }
    }

    // 2. Extract Data (Expects { data: ... })
    const data = req.body?.data || req.query || {};

    // 3. Execute Handler
    const result = await handler(data, auth);

    // 4. Return formatted response (onCall protocol: { result: ... })
    return res.status(200).json({ result });
  } catch (error: any) {
    logger.error(`💥 [API] Callable handler failed at ${req.path}:`, error);
    const status = error.code || 'internal';
    const message = error.message || 'Internal error';
    const httpStatus = (error instanceof HttpsError) ? 400 : 500;
    return res.status(httpStatus).json({ error: { status, message } });
  }
}



export const markOverdueTasks = onSchedule({ 
  schedule: 'every 60 minutes', 
  memory: '256MiB', 
  cpu: 0.125,
  maxInstances: 5 
}, async (event) => {
  const db = getDb();
  const now = new Date();
  logger.log('🕒 [OVERDUE] Starting overdue task check at:', now.toISOString());

  const snap = await db.collection('tasks').where('individualDeadline', '<', now).get();
  const batch = db.batch();
  let count = 0;
  snap.docs.forEach((d) => {
    const data = d.data() as any;
    const status = String(data?.status || '').toLowerCase();
    if (status !== 'completed' && status !== 'overdue') {
      batch.update(d.ref, { status: 'overdue', updatedAt: now });
      count += 1;
    }
  });

  if (count > 0) {
    await batch.commit();
    logger.log(`🕒 [OVERDUE] Marked ${count} tasks as overdue`);
  } else {
    logger.log('🕒 [OVERDUE] No new overdue tasks found');
  }

  try {
    const settingsSnap = await db.collection('settings').doc('workflow').get();
    const releaseOnOverdue = !!(settingsSnap.exists && settingsSnap.data()?.releaseOnOverdue === true);

    if (releaseOnOverdue) {
      logger.log('🕒 [OVERDUE] Workflow release on overdue is ENABLED');
      const overdueSnap = await db.collection('tasks').where('status', '==', 'overdue').get();
      const relBatch = db.batch();
      overdueSnap.docs.forEach((doc) => {
        const t = doc.data() as any;
        const wfId = String(t.workflowId || '');
        const seq = Number(t.sequenceIndex);
        if (!wfId || !Number.isFinite(seq)) return;
        relBatch.update(doc.ref, { isCurrentStep: false, updatedAt: now });
        relBatch.update(doc.ref, { updatedAt: now });
      });
      await relBatch.commit();
      const nextBatch = db.batch();
      for (const doc of overdueSnap.docs) {
        const t = doc.data() as any;
        const wfId = String(t.workflowId || '');
        const seq = Number(t.sequenceIndex);
        if (!wfId || !Number.isFinite(seq)) continue;
        const nextQuery = await db.collection('tasks').where('workflowId', '==', wfId).where('sequenceIndex', '==', seq + 1).limit(1).get();
        if (!nextQuery.empty) {
          const nextRef = nextQuery.docs[0].ref;
          nextBatch.update(nextRef, { releasedAt: now, isCurrentStep: true, updatedAt: now });
        }
      }
      await nextBatch.commit();
    }
  } catch (e) {
    logger.error('🕒 [OVERDUE] Failed to process workflow releases:', e);
  }

  logger.log('🕒 [OVERDUE] Overdue task check completed');
});

// 🏆 SERVER-SIDE AGGREGATION: Optimized leaderboard data aggregation
// This function creates aggregated leaderboard data to eliminate expensive client-side queries
// 🏆 SERVER-SIDE AGGREGATION: Optimized leaderboard data aggregation (Internal Handler)
async function handleLeaderboardAggregate(req: any, res: any) {
  try {
    const db = getDb();
    const { page = 1, pageSize = 10, chapterId } = req.query;

    logger.log('🏆 [AGGREGATION] Starting leaderboard aggregation', { page, pageSize, chapterId });

    const pageNum = parseInt(page as string) || 1;
    const size = Math.min(parseInt(pageSize as string) || 10, 50); // Max 50 per page
    const offset = (pageNum - 1) * size;

    // Build the query
    let query = db.collection('users') as any;

    // Chapter filter if provided
    if (chapterId && typeof chapterId === 'string') {
      query = query.where('chapterId', '==', chapterId);
    }

    // Get paginated results
    const snapshot = await query
      .orderBy('points', 'desc')
      .offset(offset)
      .limit(size)
      .get();

    // Process the aggregated data
    const rawUsers = snapshot.docs.map((doc: any) => {
      const data = doc.data();
      return {
        id: doc.id,
        displayName: data.displayName || data.name || data.email || 'Anonymous',
        email: data.email || '',
        photoURL: data.photoURL || undefined,
        points: Number(data.points || 0),
        totalHoursWorked: Number(data.totalHoursWorked || 0),
        chapterId: data.chapterId || undefined,
        tasksAssignedCount: Number(data.tasksAssignedCount || 0),
        tasksCompletedOnTimeCount: Number(data.tasksCompletedOnTimeCount || 0),
        university: data.university || undefined,
        upvotes: Number(data.upvotes || 0),
        downvotes: Number(data.downvotes || 0),
        badges: Array.isArray(data.badges) ? data.badges.slice(0, 5) : [],
        role: data.displayRole || null,
        isOnVacation: data.isOnVacation || false,
      };
    });

    const chapterIds = Array.from(new Set(rawUsers.map((u: any) => u.chapterId).filter(Boolean))) as string[];
    const chapterNameMap: Record<string, string> = {};
    if (chapterIds.length > 0) {
      const snaps = await Promise.all(chapterIds.map(id => db.collection('chapters').doc(id).get()));
      snaps.forEach((snap, idx) => {
        if (snap.exists) {
          const d = snap.data() as any;
          chapterNameMap[chapterIds[idx]] = String(d?.name || d?.title || '');
        }
      });
    }

    const users = rawUsers.map((u: any) => ({
      ...u,
      chapter: u.chapterId ? { name: chapterNameMap[u.chapterId] || '' } : undefined,
    }));

    // Calculate pagination info using count() for efficiency
    const totalUsersQuery = chapterId
      ? db.collection('users').where('chapterId', '==', chapterId)
      : db.collection('users');

    const totalUsersCountSnap = await totalUsersQuery.count().get();
    const totalUsers = totalUsersCountSnap.data().count;

    const totalPages = Math.ceil(totalUsers / size);
    const hasNext = pageNum < totalPages;
    const hasPrev = pageNum > 1;

    const result = {
      users,
      pagination: {
        page: pageNum,
        pageSize: size,
        totalUsers,
        totalPages,
        hasNext,
        hasPrev,
      },
      timestamp: new Date().toISOString(),
    };

    logger.log('🏆 [AGGREGATION] Aggregation completed', {
      usersCount: users.length,
      page: pageNum,
      totalUsers,
      totalPages,
    });

    // Cache for 30 seconds
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.status(200).json(result);

  } catch (error) {
    logger.error('❌ [AGGREGATION] Leaderboard aggregation failed:', error);
    res.status(500).json({
      error: 'Failed to aggregate leaderboard data',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}


// 🏆 POSITION MANAGEMENT: Automated continuity system for organizational leadership
// When a new position is created without an end date, automatically close the previous position

// 📋 [CONSOLIDATED TRIGGER] Unified Position Management
// Handles automatic continuity, end-date management, and audit logging
export const onPositionWritten = onDocumentWritten({
  document: 'positions/{positionId}',
  memory: '256MiB',
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  const db = getDb();
  const positionId = event.params.positionId;
  const before = event.data?.before.exists ? event.data.before.data() as any : null;
  const after = event.data?.after.exists ? event.data.after.data() as any : null;

  // 1. Handle Deletion
  if (!after) {
    logger.log('🗑️ [POSITION] Position deleted:', positionId);
    if (!before.endDate) {
      await db.collection('audit_logs').add({
        type: 'position_deletion',
        action: 'current_position_deleted',
        positionId,
        role: before.role,
        userId: before.userId,
        startDate: before.startDate,
        deletedAt: new Date(),
        systemGenerated: true,
        warning: 'A current position was deleted - manual review recommended'
      });
    }
    return;
  }

  // 2. Handle Continuity (Creation or Update that makes it current)
  const isNowCurrent = !after.endDate;
  const wasNotCurrent = !before || before.endDate;

  if (isNowCurrent && (wasNotCurrent || before.role !== after.role)) {
    logger.log('📋 [POSITION] Current position detected, maintaining continuity:', positionId);
    try {
      const newStartDate = after.startDate;
      const role = after.role;

      // Find previous current position for same role
      const previousPositionsQuery = await db.collection('positions')
        .where('role', '==', role)
        .where('endDate', '==', null)
        .get();

      const batch = db.batch();
      let updatedCount = 0;

      for (const doc of previousPositionsQuery.docs) {
        if (doc.id !== positionId) {
          batch.update(doc.ref, {
            endDate: newStartDate,
            updatedAt: new Date(),
            continuityUpdated: true,
            updatedBy: 'system'
          });
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        await batch.commit();
        logger.log(`✅ [POSITION] Closed ${updatedCount} previous positions for role: ${role}`);
      }
    } catch (error) {
      logger.error('❌ [POSITION] Continuity check failed:', error);
    }
  }
});

// Helper function to manually trigger position continuity check (Internal Handler)
async function handleCheckPositionContinuity(data: any, auth: any) {
  const db = getDb();
  const uid = auth?.uid;

  if (!uid) {
    throw new HttpsError('unauthenticated', 'User must be signed in');
  }

  try {
    // This would typically check if the user has admin privileges
    // For now, we'll allow any authenticated user to trigger this

    logger.log('🔧 [POSITION] Manual continuity check requested by:', uid);

    // Find all roles that might have multiple current positions
    const positionsQuery = await db.collection('positions')
      .where('endDate', '==', null)
      .get();

    const positionsByRole: Record<string, any[]> = {};

    positionsQuery.docs.forEach(doc => {
      const position = doc.data();
      const role = position.role;
      if (!positionsByRole[role]) {
        positionsByRole[role] = [];
      }
      positionsByRole[role].push({ id: doc.id, ...position });
    });

    const issues = [];

    // Check for roles with multiple current positions
    for (const [role, positions] of Object.entries(positionsByRole)) {
      if (positions.length > 1) {
        issues.push({
          role,
          currentPositions: positions.length,
          positionIds: positions.map(p => p.id)
        });
      }
    }

    if (issues.length > 0) {
      logger.warn('🔍 [POSITION] Found continuity issues:', issues);
    } else {
      logger.log('✅ [POSITION] No continuity issues found');
    }

    return {
      success: true,
      message: issues.length === 0 ? 'No continuity issues found' : 'Continuity issues detected',
      issues: issues,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    logger.error('❌ [POSITION] Manual continuity check failed:', error);
    throw new HttpsError('internal', 'Failed to perform continuity check');
  }
}


// Transactional event registration (Internal Handler)
async function handleRegisterForEvent(data: any, auth: any) {
  const db = getDb();
  const uid = auth?.uid;

  if (!uid) {
    throw new HttpsError('unauthenticated', 'User must be signed in');
  }
  const eventId = typeof data?.eventId === 'string' ? data.eventId.trim() : '';
  if (!eventId) {
    throw new HttpsError('invalid-argument', 'eventId is required');
  }

  try {
    await db.runTransaction(async (tx) => {
      const eventRef = db.collection('events').doc(eventId);
      const regRef = eventRef.collection('registrations').doc(uid);
      const userRef = db.collection('users').doc(uid);
      const configRef = db.collection('warningConfig').doc('global');

      const [eventSnap, regSnap, userSnap, configSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(regRef),
        tx.get(userRef),
        tx.get(configRef),
      ]);

      if (!eventSnap.exists) {
        throw new HttpsError('not-found', 'Event not found');
      }

      // 🛑 ENFORCEMENT CHECK: Block blacklisted users if enforcement is enabled
      const userData = userSnap.data() || {};
      const configData = configSnap.data() || { enforcementEnabled: true };

      if (configData.enforcementEnabled && userData.isBlacklisted === true) {
        throw new HttpsError('permission-denied', 'Your account is currently blacklisted. Event registration is restricted.');
      }

      const event = eventSnap.data() as any;
      const capacity = Number(event?.capacity || 0);
      const registrationOpen = !!event?.registrationOpen;
      const status = String(event?.status || event?.published ? 'published' : 'draft');
      const attendeeIds: string[] = Array.isArray(event?.attendeeIds) ? event.attendeeIds.filter((x: any) => typeof x === 'string') : [];

      if (!registrationOpen || status !== 'published') {
        throw new HttpsError('failed-precondition', 'Registration is closed for this event');
      }

      if (regSnap.exists) {
        const existing = regSnap.data() as any;
        const st = String(existing?.status || 'pending');
        if (st !== 'cancelled') {
          // Already registered; idempotent success
          return;
        }
      }

      const currentCount = attendeeIds.length;
      if (capacity && currentCount >= capacity) {
        throw new HttpsError('failed-precondition', 'Sorry, this event is full');
      }

      const now = new Date();
      const displayName = userSnap.exists ? (userSnap.data() as any)?.displayName || null : null;
      const email = userSnap.exists ? (userSnap.data() as any)?.email || null : null;
      const whatsappE164 = typeof data?.whatsappE164 === 'string' ? data.whatsappE164 : null;
      const isPaidEvent = !!(event?.paymentDetails?.isPaid === true);
      const paymentMethod = typeof data?.paymentMethod === 'string' ? data.paymentMethod : (event?.paymentDetails?.method || null);

      tx.update(eventRef, {
        attendeeIds: require('firebase-admin/firestore').FieldValue.arrayUnion(uid) as any,
        registrationsCount: require('firebase-admin/firestore').FieldValue.increment(1) as any,
        updatedAt: now,
      } as any);

      tx.set(regRef, {
        uid,
        eventId,
        displayName,
        email,
        whatsappE164,
        status: 'pending',
        paymentStatus: isPaidEvent ? 'unpaid' : 'verified',
        paymentMethod,
        paymentRef: null,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
    });
    return { ok: true };
  } catch (error: any) {
    if (error instanceof HttpsError) throw error;
    const msg = typeof error?.message === 'string' ? error.message : 'Registration failed';
    throw new HttpsError('unknown', msg);
  }
}


// ============================================================================
// UNIVERSAL SUBMISSIONS (FIREBASE VARIANT) - NoSQL Fan-Out Aggregation
// ============================================================================
// This guarantees Submissions can be fetched in one O(1) query per page.

async function getUserChapterId(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const db = getDb();
    const userDoc = await db.collection('users').doc(userId).get();
    return userDoc.exists ? (userDoc.data()?.chapterId || null) : null;
  } catch (e) {
    return null;
  }
}

async function handleUniversalSubmissionSync(
  event: any,
  collectionName: string,
  typeMapping: string,
  summaryExtractor: (data: any) => string,
  userExtractor: (data: any) => string,
  statusExtractor: (data: any) => string,
  userDisplayNameExtractor?: (data: any) => string
) {
  const db = getDb();
  const docId = event.params.docId;
  const originalRef = `${collectionName}/${docId}`;

  // Deterministic global mapping
  const globalId = `${collectionName}_${docId}`;
  const destRef = db.collection('universal_submissions').doc(globalId);

  // Handle deletions explicitly
  if (!event.data?.after?.exists) {
    await destRef.delete();
    logger.log(`🗑️ [UNIVERSAL_SYNC] Trashed ${globalId}`);
    return;
  }

  const data = event.data.after.data();
  const status = statusExtractor(data);
  const userId = userExtractor(data);

  // Resolve RBAC Context dynamically if omitted in source
  let chapterId = data.chapterId || data.chapter_id || null;
  if (!chapterId && userId) {
    chapterId = await getUserChapterId(userId);
  }

  const summaryText = summaryExtractor(data);

  // Resolve User Details if not already in source document (for denormalization)
  let userDisplayName = userDisplayNameExtractor ? userDisplayNameExtractor(data) : (data.userDisplayName || data.name || null);
  let userPhotoURL = data.userPhotoURL || data.photoURL || null;

  if (userId && (!userDisplayName || !userPhotoURL)) {
    try {
      const uDoc = await db.collection('users').doc(userId).get();
      if (uDoc.exists) {
        const u = uDoc.data()!;
        if (!userDisplayName) userDisplayName = u.displayName || u.name || null;
        if (!userPhotoURL) userPhotoURL = u.photoURL || null;
      }
    } catch (e) {
      // Ignore fetch errors
    }
  }

  // Default to server timestamp if created_at is omitted
  const createdAt = data.createdAt || data.submittedAt || data.created_at || require('firebase-admin/firestore').FieldValue.serverTimestamp();

  const payload = {
    global_id: globalId,
    original_ref: originalRef,
    type: typeMapping,
    status: status,
    created_at: createdAt,
    user_id: userId || null,
    user_display_name: userDisplayName || 'Anonymous',
    user_photo_url: userPhotoURL || null,
    chapter_id: chapterId || null,
    summary_text: summaryText || `${typeMapping} Submission`
  };

  await destRef.set(payload, { merge: true });
  logger.log(`✅ [UNIVERSAL_SYNC] Aggregated ${globalId} -> ${status}`);
}

export const onLeaveRequestSync = onDocumentWritten({ 
  document: 'leave_requests/{docId}', 
  memory: '256MiB', 
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  await handleUniversalSubmissionSync(
    event,
    'leave_requests',
    'LEAVE_REQUEST',
    (d) => `Leave Request: ${d.startDate || d.start_date || '?'} to ${d.endDate || d.end_date || '?'}`,
    (d) => d.userId || d.user_id,
    (d) => (d.status || 'PENDING').toUpperCase()
  );
});

export const onApplicationSync = onDocumentWritten({ 
  document: 'applications/{docId}', 
  memory: '256MiB', 
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  await handleUniversalSubmissionSync(
    event,
    'applications',
    'APPLICATION',
    (d) => `Application: ${d.roleAppliedFor || d.role_applied_for || d.position || 'Unknown Role'}`,
    (d) => d.userId || d.user_id,
    (d) => (d.status || 'PENDING').toUpperCase()
  );
});

export const onFormResponseSync = onDocumentWritten({ 
  document: 'form_responses/{docId}', 
  memory: '256MiB', 
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  await handleUniversalSubmissionSync(
    event,
    'form_responses',
    'FORM_RESPONSE',
    (d) => `Form Response: ${d.formTitle || d.formId || 'User Submission'}`,
    (d) => d.userId || d.user_id,
    (d) => (d.status || 'PENDING').toUpperCase()
  );
});

export const onSubmissionItemSync = onDocumentWritten({ 
  document: 'submissions/{docId}', 
  memory: '256MiB', 
  cpu: 0.125, 
  maxInstances: 5
}, async (event) => {
  await handleUniversalSubmissionSync(
    event,
    'submissions',
    'SUBMISSION',
    (d) => `${(d.type || 'Submission').toUpperCase()}: ${d.title || 'Untitled'}`,
    (d) => d.userId || d.user_id,
    (d) => (d.status || 'PENDING').toUpperCase()
  );
});

/**
 * 🛰️ MULTI-CHANNEL WATCHDOG
 * Automatically dispatches Push notifications when a new notification document is created in Firestore.
 * This bridges historical systems (like Cloud Functions) that only write to Firestore.
 */
export const onNotificationCreatedDispatchPush = onDocumentCreated({ 
  document: 'users/{userId}/notifications/{notifId}', 
  memory: '256MiB', 
  cpu: 0.125,
  maxInstances: 5
}, async (event) => {
  const db = getDb();
  const notification = event.data?.data();
  if (!notification) return;

  const { userId } = event.params;
  const priority = notification.priority || 'P2';

  // Skip routine notifications for Push
  if (priority === 'P3') return;

  logger.log(`🛰️ [WATCHDOG] Dispatching push for ${userId}: ${notification.title}`);

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;

    const userData = userDoc.data();
    const tokens: string[] = userData?.fcmTokens || [];
    const pushEnabled = userData?.pushEnabled !== false;

    if (!pushEnabled || tokens.length === 0) {
      logger.log(`🛰️ [WATCHDOG] Push disabled or no tokens for user: ${userId}`);
      return;
    }

    // Since we're in Cloud Functions, we use the Admin SDK directly
    const message = {
      tokens,
      notification: {
        title: notification.title,
        body: notification.body || notification.message,
      },
      data: {
        link: notification.link || '/',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
      },
      webpush: {
        fcmOptions: {
          link: notification.link || '/'
        }
      }
    };

    const response = await getMessagingSvc().sendEachForMulticast(message as any);
    logger.log(`🛰️ [WATCHDOG] FCM Response: ${response?.successCount} success, ${response?.failureCount} failed`);
  } catch (error) {
    logger.error('🛰️ [WATCHDOG] Push dispatch failed:', error);
  }
});
