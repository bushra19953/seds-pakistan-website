import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { admin } from '@/lib/server/firebase-admin';
import { getWebhooksDb } from '@/lib/server/webhooks/supa-handle';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import {
  mirrorNotificationCreate,
  userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';
import { isSupaPrimary } from '@/lib/supa/flags';
import { applyPointsAwardViaSupa } from '@/lib/supa/gamification';
import {
  flushPendingUsersPrimaryOps,
  identityPrimaryFlagOn,
  primaryIdentitySet,
  primaryIdentityUpdateIfExists,
  type PendingUsersPrimaryOp,
} from '@/lib/server/supa-identity-primary';

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

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      // Malformed JSON is a client error, never a 500: the handler must not
      // crash on a body it cannot parse.
      return NextResponse.json({ error: 'Malformed JSON payload' }, { status: 400 });
    }
    const { collection, docId, eventType, before, after } = payload ?? {};

    // Type-check the routing fields: a non-string collection would crash
    // `collection.includes(...)` below (TypeError -> 500). Reject it as 400.
    if (
      typeof collection !== 'string' || !collection ||
      typeof docId !== 'string' || !docId ||
      typeof eventType !== 'string' || !eventType
    ) {
      return NextResponse.json({ error: 'Missing webhook payload parameters' }, { status: 400 });
    }

    const db = getWebhooksDb();
    if (!db) {
      // Database unavailable is a dependency failure, not a handler bug.
      return NextResponse.json({ success: false, error: 'Database unavailable' }, { status: 503 });
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
  // A create/update/universal-sync with no `after` object (fresh doc with no
  // payload, malformed client body) has nothing to act on. Bail out instead
  // of dereferencing `after.*` below (TypeError -> 500).
  if (eventType !== 'delete' && (!after || typeof after !== 'object')) {
    return;
  }
  // 1. Deletion
  if (eventType === 'delete' || !after) {
    console.log('🗑️ [TASK] Deletion detected:', taskId);
    const deletedIds: string[] = Array.isArray(before?.assigneeIds) && before.assigneeIds.length
      ? before.assigneeIds.map(String).filter(Boolean)
      : (before?.userId || before?.assigneeId ? [String(before.userId || before.assigneeId)] : []);
    for (const userId of deletedIds) {
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
      // GAP-N1: queued notification mirrors, flushed after commit.
      const notifMirrors: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];
      for (const uid of assigneeIds) {
        const notifRef = db.collection('users').doc(uid).collection('notifications').doc();
        const notifData = {
          userId: uid, type: 'task-assigned', title: 'New Task Assigned',
          body: `You have been assigned a new task: "${after.title}"`,
          taskId, createdAt: now, isRead: false, priority: 'P1', link: `/tasks/${taskId}`,
        };
        batch.set(notifRef, notifData);
        notifMirrors.push({ uid, id: notifRef.id, data: notifData });
      }
      await batch.commit();
      for (const m of notifMirrors) {
        await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
      }
    }
  }

  // 3. Updates (Reward logic)
  if (eventType === 'update' && before && after) {
    const wasCompleted = before.status === 'completed';
    const isCompleted = after.status === 'completed';
    
    if (isCompleted && !wasCompleted) {
      // C-07 guard swap: under gamification Supa-primary, the reward is
      // claimed through apply_points_award (see handleTaskRewardViaSupa);
      // the Firestore transaction below is the OFF path, byte-identical.
      if (isSupaPrimary('gamification')) {
        await handleTaskRewardViaSupa(db, taskId);
      } else try {
        const taskRef = db.collection('tasks').doc(taskId);
        // GAP-N1: notifications written inside the transaction; mirrored
        // only after the transaction commits (flag-gated, non-throwing).
        const notifMirrors: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];
        // WRITE PRIMACY (identity full build, G-USER-5, U-45): the
        // users counter ops are QUEUED inside the tx and flushed to
        // the adapter AFTER the tx commits (the GAP-N1 queued-flush
        // pattern for tx writers) — applying RMW increments inside
        // the callback would double-apply on a Firestore tx retry,
        // since the callback can re-execute while the Firestore
        // increments apply exactly once at commit. Named order
        // exception for this site: primary-after-tx, guarded by the
        // same rewardApplied flag; the webhook trigger question
        // itself is a program-level blocker (design §7.3).
        const pendingUsersPrimary: PendingUsersPrimaryOp[] = [];
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
            const rewardPayload = {
              points: FieldValue.increment(points),
              totalHoursWorked: FieldValue.increment(hoursWorked),
              tasksCompletedCount: FieldValue.increment(1),
              tasksCompletedOnTimeCount: FieldValue.increment(onTime ? 1 : 0),
              lastTaskCompletedAt: now,
            };
            tx.update(userRef, rewardPayload);
            pendingUsersPrimary.push({ uid, payload: rewardPayload });
            if (badgeId) {
              tx.update(userRef, { badges: FieldValue.arrayUnion(badgeId) });
              pendingUsersPrimary.push({ uid, payload: { badges: FieldValue.arrayUnion(badgeId) } });
            }
            const ledgerRef = userRef.collection('rewards').doc(taskId);
            tx.set(ledgerRef, { taskId, pointsAwarded: points, hoursAwarded: hoursWorked, badgeId, createdAt: now, onTime }, { merge: true });
            const notifRef = userRef.collection('notifications').doc();
            const notifData = { userId: uid, type: 'task-complete', title: '🏆 Task Completed!', body: `You completed "${t.title}" and earned ${points} points!`, taskId, points, hoursWorked, badgeId, createdAt: now, read: false, priority: 'P2', link: `/tasks/${taskId}` };
            tx.set(notifRef, notifData);
            notifMirrors.push({ uid, id: notifRef.id, data: notifData });
          }
          tx.update(taskRef, { rewardApplied: true, completedAt: now, updatedAt: now });
        });
        // PRIMACY flush (U-45): the queued users ops land on the
        // adapter now the tx has committed; the tx's native
        // increments stand as the reverse mirror.
        await flushPendingUsersPrimaryOps(pendingUsersPrimary);
        // GAP-N1: transaction committed — mirror its notifications.
        for (const m of notifMirrors) {
          await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
        }
      } catch (e) {
        console.error('Transactional awarding failed', { taskId, error: e });
      }
    }
    
    const updatedIds: string[] = Array.isArray(after.assigneeIds) && after.assigneeIds.length
      ? after.assigneeIds.map(String).filter(Boolean)
      : (after.userId || after.assigneeId ? [String(after.userId || after.assigneeId)] : []);
    for (const userId of updatedIds) {
      await db.collection('users').doc(userId).collection('activity').add({ type: 'taskUpdated', taskId, taskTitle: after.title, updatedAt: new Date() });
    }
  }

  // 4. Universal Submission Sync
  if (eventType !== 'delete' && after) {
    const s = String(after.status || '').toUpperCase();
    await executeUniversalSubmissionSync(db, `tasks_${taskId}`, `tasks/${taskId}`, 'TASK_REVIEW', s === 'PENDING_REVIEW' ? 'PENDING' : s, after.assigneeId || after.userId || (Array.isArray(after.assigneeIds) ? after.assigneeIds[0] : null), `Task Review: ${after.title || after.name || 'Task Completion'}`, after);
  }
}

/**
 * C-07 converted reward path (gamification Supa-primary only).
 *
 * Guard swap: the OFF path's guards — the task's `rewardApplied` flag
 * plus the per-user `users/{uid}/rewards/{taskId}` subcollection doc —
 * are replaced by the ONE program guard: the deterministic ledger
 * claim pa_<taskId>_<uid>_COMPLETION inside apply_points_award.
 * The rewards subcollection is therefore RETIRED on this path: its
 * only job was being that per-user ledger, and fs_points_ledger now
 * holds the row (with points, hours and badge in the award inputs).
 * Claim-first ordering: RPC awards run BEFORE the Firestore
 * rewardApplied stamp + notifications transaction; a replayed
 * delivery re-runs the RPCs, gets `duplicate`, and applies nothing.
 * If an RPC does not land (null = rolled back), the stamp is skipped
 * so a later delivery can retry the whole reward.
 */
async function handleTaskRewardViaSupa(db: any, taskId: string) {
  const taskRef = db.collection('tasks').doc(taskId);
  try {
    const snap = await taskRef.get();
    const t = snap.data() as any;
    if (!t || t.rewardApplied === true) return;

    const points = typeof t?.points === 'number' && t.points > 0 ? t.points : 0;
    const hoursWorked = typeof t?.hoursWorked === 'number' && t.hoursWorked > 0 ? t.hoursWorked : 0;
    const badgeId = typeof t?.completionBadgeId === 'string' && t.completionBadgeId ? t.completionBadgeId : null;
    const assigneeIds: string[] = Array.isArray(t?.assigneeIds) ? t.assigneeIds.filter((x: any) => typeof x === 'string') : (typeof t?.assigneeId === 'string' && t.assigneeId ? [t.assigneeId] : []);
    const now = new Date();
    const pDeadline = t?.deadline;
    let deadlineDate: Date | null = null;
    if (typeof pDeadline?.toDate === 'function') deadlineDate = pDeadline.toDate(); else if (pDeadline) deadlineDate = new Date(pDeadline);
    const onTime = !!(deadlineDate && now.getTime() <= deadlineDate.getTime());

    // 1. Claim-first awards (idempotent in the RPC).
    for (const uid of assigneeIds) {
      const awardResult = await applyPointsAwardViaSupa({
        taskId,
        userId: uid,
        action: 'COMPLETION',
        points,
        countCompletion: true,
        // No deadline in the OFF path means the on-time counter is
        // incremented by 0 and no late counter exists; null keeps
        // the RPC from counting either, matching that shape.
        onTime: deadlineDate ? onTime : null,
        hoursWorked,
        badgeIds: badgeId ? [badgeId] : [],
      });
      if (awardResult === null) {
        console.error('Transactional awarding failed', { taskId, error: new Error('apply_points_award did not land; reward left unstamped for retry') });
        return;
      }
    }

    // 2. rewardApplied stamp + completion notifications, same shapes
    //    as the OFF transaction, mirrored post-commit (GAP-N1 pattern).
    const notifMirrors: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];
    await db.runTransaction(async (tx: any) => {
      const freshSnap = await tx.get(taskRef);
      const ft = freshSnap.data() as any;
      if (ft && ft.rewardApplied === true) return;
      for (const uid of assigneeIds) {
        const userRef = db.collection('users').doc(uid);
        const notifRef = userRef.collection('notifications').doc();
        const notifData = { userId: uid, type: 'task-complete', title: '🏆 Task Completed!', body: `You completed "${t.title}" and earned ${points} points!`, taskId, points, hoursWorked, badgeId, createdAt: now, read: false, priority: 'P2', link: `/tasks/${taskId}` };
        tx.set(notifRef, notifData);
        notifMirrors.push({ uid, id: notifRef.id, data: notifData });
      }
      tx.update(taskRef, { rewardApplied: true, completedAt: now, updatedAt: now });
    });
    for (const m of notifMirrors) {
      await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
    }
  } catch (e) {
    console.error('Transactional awarding failed', { taskId, error: e });
  }
}

async function handleUserWritten(db: any, userId: string, before: any, after: any, eventType: string) {
  if (eventType === 'delete' || !after || typeof after !== 'object') return;
  
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
          // WRITE PRIMACY (G-USER-8, U-46): the badge union lands on
          // the adapter first under isSupaPrimary('users'); the
          // Firestore update becomes the reverse mirror. A primary
          // failure is caught by this block's existing catch (logged;
          // the Firestore leg is skipped rather than writing a
          // shadow-first copy the primary lacks).
          const badgePayload = {
            badges: FieldValue.arrayUnion(...toAward),
            updatedAt: new Date(),
          };
          if (await identityPrimaryFlagOn('users')) {
            await primaryIdentitySet('users', 'users', userId, badgePayload, { merge: true });
            try {
              await db.collection('users').doc(userId).update(badgePayload);
            } catch (mirrorErr) {
              console.error('❌ [USER] Firestore reverse mirror (badges) failed after Supa primary commit:', mirrorErr);
            }
          } else {
            await db.collection('users').doc(userId).update(badgePayload);
          }
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
  // ROOT CAUSE of the 500-on-every-new-signup (cf. commits abaa7c8/120b149):
  // at signup the `after` payload carries `email` but NO `email_lowercase`,
  // so this sync ALWAYS fires, and the user doc may not exist yet (signup
  // profile creation is best-effort). `update()` on a missing doc throws
  // NOT_FOUND, which used to bubble to the outer catch -> HTTP 500.
  // Skip-if-missing: a missing doc has nothing to sync, and a webhook
  // side-effect must never create a skeleton user doc or fail the request.
  // Only NOT_FOUND is swallowed silently; any other failure is logged and
  // the webhook still returns success (graceful degradation).
  const email = after.email;
  const emailLowercase = after.email_lowercase;
  if (typeof email === 'string' && email && (!emailLowercase || emailLowercase !== email.toLowerCase())) {
    try {
      // WRITE PRIMACY (G-USER-8, U-47): under isSupaPrimary('users')
      // the sync lands on the adapter first with its skip-if-missing
      // contract preserved on the primary leg (updateIfExists — a
      // missing primary row is a no-op skip, never a create, and the
      // Firestore leg is then skipped too: the primary is the store
      // the directory's email probe reads).
      if (await identityPrimaryFlagOn('users')) {
        const applied = await primaryIdentityUpdateIfExists('users', 'users', userId, { email_lowercase: email.toLowerCase(), updatedAt: new Date() });
        if (!applied) return;
        try {
          await db.collection('users').doc(userId).update({ email_lowercase: email.toLowerCase(), updatedAt: new Date() });
        } catch (mirrorErr) {
          console.error('❌ [USER] Firestore reverse mirror (email_lowercase) failed after Supa primary commit:', mirrorErr);
        }
        return;
      }
      await db.collection('users').doc(userId).update({ email_lowercase: email.toLowerCase(), updatedAt: new Date() });
    } catch (err: any) {
      const isNotFound =
        err?.code === 5 ||
        err?.code === 'not-found' ||
        /not[-_ ]?found/i.test(String(err?.message ?? ''));
      if (!isNotFound) {
        console.error('❌ [USER] Email-lowercase sync failed (non-fatal):', err);
      }
    }
  }
}

async function handleRoleWritten(db: any, userId: string, before: any, after: any, eventType: string) {
  try {
    const auth = getAuth();
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const chapterId = userDoc.exists ? userDoc.data()?.chapterId : null;

    if (eventType !== 'delete' && after) {
      // `after.role` must be a string: a malformed payload must not stamp a
      // non-string role onto the user doc or into custom claims.
      const newRole = after && typeof after === 'object' && typeof after.role === 'string' ? after.role : null;
      // Phase 1 (spec B.2 item 10): the users-doc mirror write is RETIRED.
      // The mirror is written transactionally by src/lib/server/role-writes.ts;
      // a second mirror writer here is how the stores diverged. The
      // custom-claims sync below may remain.
      const claims: any = {};
      if (newRole) claims.role = String(newRole);
      if (chapterId) claims.chapter_id = String(chapterId);
      await auth.setCustomUserClaims(userId, claims);
    } else {
      // Mirror write retired (see above); claims sync remains.
      const claims: any = {};
      if (chapterId) claims.chapter_id = String(chapterId);
      await auth.setCustomUserClaims(userId, claims);
    }
  } catch (error) {}
}

async function handlePositionWritten(db: any, positionId: string, before: any, after: any, eventType: string) {
  if (eventType === 'delete' || !after || typeof after !== 'object') {
    // A delete with no `before` (or a non-object `before`) has nothing to
    // audit: `before.endDate` below would throw TypeError -> 500.
    if (!before || typeof before !== 'object') {
      return;
    }
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
  // A non-object `data` (malformed client payload) must not crash on
  // `data.chapterId` below. Treat it as an empty payload: the sync row is
  // still written with fallback values.
  const dataObj = data && typeof data === 'object' ? data : {};
  let chapterId = dataObj.chapterId || dataObj.chapter_id || null;
  if (!chapterId && userId) {
    try {
      const uDoc = await db.collection('users').doc(userId).get();
      if (uDoc.exists) chapterId = uDoc.data()?.chapterId || null;
    } catch (e) {}
  }

  let userDisplayName = dataObj.userDisplayName || dataObj.name || null;
  let userPhotoURL = dataObj.userPhotoURL || dataObj.photoURL || null;

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

  const createdAt = dataObj.createdAt || dataObj.submittedAt || dataObj.created_at || FieldValue.serverTimestamp();

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
    // fcmTokens must be an array: a malformed stored value must not reach
    // sendEachForMulticast as a non-array (it throws -> 500 path).
    const tokens: string[] = Array.isArray(userData?.fcmTokens) ? userData.fcmTokens : [];
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
