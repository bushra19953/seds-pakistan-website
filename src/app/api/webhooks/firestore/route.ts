import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getDb, admin } from '@/lib/server/firebase-admin';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

// Timing-safe comparison of the caller-provided webhook secret against the
// server-side FIRESTORE_WEBHOOK_SECRET. Rejects missing or mismatched secrets.
function isValidWebhookSecret(request: Request): boolean {
  const provided = request.headers.get('x-webhook-secret');
  const expected = process.env.FIRESTORE_WEBHOOK_SECRET;
  if (!provided || !expected) {
    return false;
  }
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export async function POST(request: Request) {
  try {
    // Enforce shared-secret authentication before any role updates or mutations.
    if (!isValidWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized: invalid webhook secret' }, { status: 401 });
    }

    const payload = await request.json();
    const { collection, docId, eventType, before, after } = payload;
    
    if (!collection || !docId || !eventType) {
      return NextResponse.json({ error: 'Missing webhook payload parameters' }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      throw new Error('Database initialization failed');
    }

    console.log(`📡 [WEBHOOK] Intercepted [${eventType}] on ${collection}/${docId}`);

    // Since Vercel handles requests asynchronously, we can process routing here:
    switch (collection) {
      case 'tasks':
        await handleTaskWritten(db, docId, before, after, eventType);
        break;
      case 'users':
        await handleUserWritten(db, docId, before, after, eventType);
        break;
      case 'roles':
        await handleRoleWritten(db, docId, before, after, eventType);
        break;
      case 'positions':
        await handlePositionWritten(db, docId, before, after, eventType);
        break;
      case 'leave_requests':
      case 'applications':
      case 'form_responses':
      case 'submissions':
        await handleSubmissionsSyncRoute(db, collection, docId, eventType, before, after);
        break;
      // Handle notifications nested subcollection
      default:
        if (collection.includes('/notifications/')) {
          await handleNotificationPush(db, docId, after, eventType);
        }
        break;
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('💥 [WEBHOOK] Processing Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// -------------------------------------------------------------------------------- //
// REPLICATED TRIGGERS
// -------------------------------------------------------------------------------- //

async function handleTaskWritten(db: any, taskId: string, before: any, after: any, eventType: string) {
  // 1. Deletion
  if (eventType === 'delete' || !after) {
    console.log('🗑️ [TASK] Deletion detected:', taskId);
    const userId = before?.userId || before?.assigneeId || (Array.isArray(before?.assigneeIds) ? before.assigneeIds[0] : null);
    if (userId) {
      await db.collection('users').doc(userId).collection('activity').add({
        type: 'taskDeleted', taskId, taskTitle: before?.title || 'Untitled', deletedAt: new Date(),
      });
    }
    await db.collection('universal_submissions').doc(`tasks_${taskId}`).delete();
    return;
  }

  // 2. Creation
  if (eventType === 'create' || !before) {
    console.log('✨ [TASK] Creation detected:', taskId);
    const creatorId = after.userId || after.createdBy || after.assigneeId;
    if (creatorId) {
      await db.collection('users').doc(creatorId).collection('activity').add({
        type: 'taskCreated', taskId, taskTitle: after.title, createdAt: new Date(),
      });
    }

    const assigneeIds: string[] = Array.isArray(after.assigneeIds)
      ? after.assigneeIds.filter((id: any) => typeof id === 'string' && id.length > 0)
      : (typeof after.assigneeId === 'string' && after.assigneeId ? [after.assigneeId] : []);

    if (assigneeIds.length > 0) {
      const now = new Date();
      const batch = db.batch();
      for (const uid of assigneeIds) {
        const notifRef = db.collection('users').doc(uid).collection('notifications').doc();
        batch.set(notifRef, {
          userId: uid, type: 'task-assigned', title: 'New Task Assigned',
          body: `You have been assigned a new task: "${after.title}"`,
          taskId, createdAt: now, isRead: false, priority: 'P1', link: `/tasks/${taskId}`,
        });
      }
      await batch.commit();
    }
  }

  // 3. Updates (Reward logic)
  if (eventType === 'update' && before && after) {
    const wasCompleted = before.status === 'completed';
    const isCompleted = after.status === 'completed';
    
    if (isCompleted && !wasCompleted) {
      try {
        const taskRef = db.collection('tasks').doc(taskId);
        await db.runTransaction(async (tx: any) => {
          const snap = await tx.get(taskRef);
          const t = snap.data() as any;
          if (t && t.rewardApplied === true) return;
          
          const points = typeof t?.points === 'number' && t.points > 0 ? t.points : 0;
          const hoursWorked = typeof t?.hoursWorked === 'number' && t.hoursWorked > 0 ? t.hoursWorked : 0;
          const badgeId = typeof t?.completionBadgeId === 'string' && t.completionBadgeId ? t.completionBadgeId : null;
          const assigneeIds: string[] = Array.isArray(t?.assigneeIds) ? t.assigneeIds.filter((x: any) => typeof x === 'string') : (typeof t?.assigneeId === 'string' && t.assigneeId ? [t.assigneeId] : []);
          const now = new Date();
          const pDeadline = t?.deadline;
          let deadlineDate: Date | null = null;
          if (typeof pDeadline?.toDate === 'function') deadlineDate = pDeadline.toDate(); else if (pDeadline) deadlineDate = new Date(pDeadline);
          const onTime = !!(deadlineDate && now.getTime() <= deadlineDate.getTime());
          
          for (const uid of assigneeIds) {
            const userRef = db.collection('users').doc(uid);
            tx.update(userRef, {
              points: FieldValue.increment(points),
              totalHoursWorked: FieldValue.increment(hoursWorked),
              tasksCompletedCount: FieldValue.increment(1),
              tasksCompletedOnTimeCount: FieldValue.increment(onTime ? 1 : 0),
              lastTaskCompletedAt: now,
            });
            if (badgeId) tx.update(userRef, { badges: FieldValue.arrayUnion(badgeId) });
            const ledgerRef = userRef.collection('rewards').doc(taskId);
            tx.set(ledgerRef, { taskId, pointsAwarded: points, hoursAwarded: hoursWorked, badgeId, createdAt: now, onTime }, { merge: true });
            const notifRef = userRef.collection('notifications').doc();
            tx.set(notifRef, { userId: uid, type: 'task-complete', title: '🏆 Task Completed!', body: `You completed "${t.title}" and earned ${points} points!`, taskId, points, hoursWorked, badgeId, createdAt: now, read: false, priority: 'P2', link: `/tasks/${taskId}` });
          }
          tx.update(taskRef, { rewardApplied: true, completedAt: now, updatedAt: now });
        });
      } catch (e) {
        console.error('Transactional awarding failed', { taskId, error: e });
      }
    }
    
    const userId = after.userId || after.assigneeId || (Array.isArray(after.assigneeIds) ? after.assigneeIds[0] : null);
    if (userId) {
      await db.collection('users').doc(userId).collection('activity').add({ type: 'taskUpdated', taskId, taskTitle: after.title, updatedAt: new Date() });
    }
  }

  // 4. Universal Submission Sync
  if (eventType !== 'delete' && after) {
    const s = String(after.status || '').toUpperCase();
    await executeUniversalSubmissionSync(db, `tasks_${taskId}`, `tasks/${taskId}`, 'TASK_REVIEW', s === 'PENDING_REVIEW' ? 'PENDING' : s, after.assigneeId || after.userId || (Array.isArray(after.assigneeIds) ? after.assigneeIds[0] : null), `Task Review: ${after.title || after.name || 'Task Completion'}`, after);
  }
}

async function handleUserWritten(db: any, userId: string, before: any, after: any, eventType: string) {
  if (eventType === 'delete' || !after) return;
  
  if (eventType === 'update' && before && after) {
    const beforePoints = Number(before.points || 0);
    const afterPoints = Number(after.points || 0);
    
    // Badges
    if (afterPoints > beforePoints) {
      try {
        const snapshot = await db.collection('badges').get();
        const badgeDocs = snapshot.docs.map((d: any) => d.data());
        const owned: string[] = Array.isArray(after.badges) ? after.badges.filter((s: any) => typeof s === 'string') : [];
        const toAward: string[] = badgeDocs
          .filter((b:any) => b?.isActive !== false && Number(b?.pointsRequired || 0) <= afterPoints)
          .map((b:any) => String(b?.slug || ''))
          .filter((slug:any) => slug.length > 0 && !owned.includes(slug));

        if (toAward.length > 0) {
          await db.collection('users').doc(userId).update({
            badges: FieldValue.arrayUnion(...toAward),
            updatedAt: new Date(),
          });
          console.info(`🏆 [USER] Awarded badges to ${userId}: ${toAward.join(', ')}`);
        }
      } catch (err) {
        console.error('❌ [USER] Badge awarding failed:', err);
      }
    }

    // Leaderboard Cache
    const relevantFields = ['points', 'displayName', 'upvotes', 'downvotes', 'photoURL', 'badges', 'chapterId', 'displayRole'];
    const hasRelevantChanges = relevantFields.some(f => before[f] !== after[f]);
    if (hasRelevantChanges) {
      await db.collection('cache').doc('leaderboard').set({ lastUpdated: new Date(), invalidatedUser: userId }, { merge: true });
    }
    
    // Claims Sync
    if (before.chapterId !== after.chapterId) {
      try {
        const auth = getAuth();
        const userRec = await auth.getUser(userId);
        const newClaims = { ...(userRec.customClaims || {}) };
        if (after.chapterId) newClaims.chapter_id = String(after.chapterId);
        else delete newClaims.chapter_id;
        await auth.setCustomUserClaims(userId, newClaims);
      } catch (e) {}
    }
  }

  // Email Sync
  const email = after.email;
  const emailLowercase = after.email_lowercase;
  if (email && (!emailLowercase || emailLowercase !== email.toLowerCase())) {
    await db.collection('users').doc(userId).update({ email_lowercase: email.toLowerCase(), updatedAt: new Date() });
  }
}

async function handleRoleWritten(db: any, userId: string, before: any, after: any, eventType: string) {
  try {
    const auth = getAuth();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const chapterId = userDoc.exists ? userDoc.data()?.chapterId : null;

    if (eventType !== 'delete' && after) {
      const newRole = after.role || null;
      await userRef.update({ displayRole: newRole, updatedAt: new Date() });
      const claims: any = {};
      if (newRole) claims.role = String(newRole);
      if (chapterId) claims.chapter_id = String(chapterId);
      await auth.setCustomUserClaims(userId, claims);
    } else {
      await userRef.update({ displayRole: null, updatedAt: new Date() });
      const claims: any = {};
      if (chapterId) claims.chapter_id = String(chapterId);
      await auth.setCustomUserClaims(userId, claims);
    }
  } catch (error) {}
}

async function handlePositionWritten(db: any, positionId: string, before: any, after: any, eventType: string) {
  if (eventType === 'delete' || !after) {
    if (!before.endDate) {
      await db.collection('audit_logs').add({
        type: 'position_deletion', action: 'current_position_deleted', positionId, role: before.role, userId: before.userId, startDate: before.startDate, deletedAt: new Date(), systemGenerated: true, warning: 'A current position was deleted - manual review recommended'
      });
    }
    return;
  }

  const isNowCurrent = !after.endDate;
  const wasNotCurrent = !before || before.endDate;

  if (isNowCurrent && (wasNotCurrent || before.role !== after.role)) {
    try {
      const newStartDate = after.startDate;
      const role = after.role;

      const previousPositionsQuery = await db.collection('positions')
        .where('role', '==', role).where('endDate', '==', null).get();

      const batch = db.batch();
      let updatedCount = 0;

      for (const doc of previousPositionsQuery.docs) {
        if (doc.id !== positionId) {
          batch.update(doc.ref, { endDate: newStartDate || new Date(), updatedAt: new Date(), continuityUpdated: true, updatedBy: 'system' });
          updatedCount++;
        }
      }

      if (updatedCount > 0) await batch.commit();
    } catch (error) {}
  }
}

async function handleSubmissionsSyncRoute(db: any, col: string, docId: string, eventType: string, before: any, after: any) {
  const globalId = `${col}_${docId}`;
  if (eventType === 'delete' || !after) {
    await db.collection('universal_submissions').doc(globalId).delete();
    return;
  }
  
  let typeMapping = 'SUBMISSION';
  let summaryText = 'Submission';
  const status = String(after.status || 'PENDING').toUpperCase();
  const userId = after.userId || after.user_id;

  if (col === 'leave_requests') {
    typeMapping = 'LEAVE_REQUEST';
    summaryText = `Leave Request: ${after.startDate || after.start_date || '?'} to ${after.endDate || after.end_date || '?'}`;
  } else if (col === 'applications') {
    typeMapping = 'APPLICATION';
    summaryText = `Application: ${after.roleAppliedFor || after.role_applied_for || after.position || 'Unknown Role'}`;
  } else if (col === 'form_responses') {
    typeMapping = 'FORM_RESPONSE';
    summaryText = `Form Response: ${after.formTitle || after.formId || 'User Submission'}`;
  } else if (col === 'submissions') {
    summaryText = `${(after.type || 'Submission').toUpperCase()}: ${after.title || 'Untitled'}`;
  }

  await executeUniversalSubmissionSync(db, globalId, `${col}/${docId}`, typeMapping, status, userId, summaryText, after);
}

async function executeUniversalSubmissionSync(db: any, globalId: string, originalRef: string, type: string, status: string, userId: string, summaryText: string, data: any) {
  let chapterId = data.chapterId || data.chapter_id || null;
  if (!chapterId && userId) {
    try {
      const uDoc = await db.collection('users').doc(userId).get();
      if (uDoc.exists) chapterId = uDoc.data()?.chapterId || null;
    } catch (e) {}
  }

  let userDisplayName = data.userDisplayName || data.name || null;
  let userPhotoURL = data.userPhotoURL || data.photoURL || null;

  if (userId && (!userDisplayName || !userPhotoURL)) {
    try {
      const uDoc = await db.collection('users').doc(userId).get();
      if (uDoc.exists) {
        const u = uDoc.data()!;
        if (!userDisplayName) userDisplayName = u.displayName || u.name || null;
        if (!userPhotoURL) userPhotoURL = u.photoURL || null;
      }
    } catch (e) {}
  }

  const createdAt = data.createdAt || data.submittedAt || data.created_at || FieldValue.serverTimestamp();

  await db.collection('universal_submissions').doc(globalId).set({
    global_id: globalId,
    original_ref: originalRef,
    type, status,
    created_at: createdAt,
    user_id: userId || null,
    user_display_name: userDisplayName || 'Anonymous',
    user_photo_url: userPhotoURL || null,
    chapter_id: chapterId || null,
    summary_text: summaryText
  }, { merge: true });
}

async function handleNotificationPush(db: any, notifId: string, payload: any, eventType: string) {
  if (eventType !== 'create' || !payload) return;
  const priority = payload.priority || 'P2';
  if (priority === 'P3') return;

  try {
    const userId = payload.userId;
    if (!userId) return;
    
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;

    const userData = userDoc.data();
    const tokens: string[] = userData?.fcmTokens || [];
    const pushEnabled = userData?.pushEnabled !== false;

    if (!pushEnabled || tokens.length === 0) return;

    const message = {
      tokens,
      notification: { title: payload.title, body: payload.body || payload.message },
      data: { link: payload.link || '/', clickAction: 'FLUTTER_NOTIFICATION_CLICK' },
      webpush: { fcmOptions: { link: payload.link || '/' } }
    };

    await getMessaging().sendEachForMulticast(message);
  } catch (error) {
    console.error('🛰️ [WATCHDOG] Push dispatch failed:', error);
  }
}
