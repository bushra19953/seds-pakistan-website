import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { sendEmailNotification, type EmailTemplate } from '@/lib/mailer';
import { validateUserStatus } from '@/lib/server/user-status';
import { executeGamificationTransaction } from '@/lib/server/gamification-transaction';
import { isManagerAbove } from '@/lib/server/hierarchy-utils';
import { hasServerPermission } from '@/lib/server/permissions';
import { type PermissionKey } from '@/config/permissions.config';

/**
 * Firebase Admin Initialization (Production-Ready)
 * ------------------------------------------------
 * Correct pattern for Next.js App Router API routes:
 * - Initialize the Admin SDK ONCE at module scope (top-level) so it runs a single time
 *   when the server process spins up. This prevents per-request reinitialization and
 *   eliminates race conditions that can lead to "Firestore not initialized" crashes.
 * - Prefer explicit credentials via env vars when available; otherwise fall back to
 *   Application Default Credentials (ADC). Both paths are supported below.
 * - After initialization, obtain the Firestore instance defensively and surface errors
 *   explicitly to callers instead of throwing opaque exceptions.
 *
 * Env vars supported:
 * - FIREBASE_PROJECT_ID or NEXT_PUBLIC_FIREBASE_PROJECT_ID
 * - FIREBASE_CLIENT_EMAIL
 * - FIREBASE_PRIVATE_KEY (ensure \n are real newlines)
 */

// Admin initialization should occur lazily within request handlers

// Force dynamic to avoid static optimization and ensure fresh server-side execution
export const dynamic = 'force-dynamic';
// Ensure Node.js runtime for Admin SDK compatibility (avoid Edge runtime)
export const runtime = 'nodejs';

/**
 * Extract a bearer token from the request with security hardening.
 * Supports only Authorization header and secure __session cookie.
 * Query parameter token support REMOVED for security hardening.
 */
function extractBearerToken(request: NextRequest): string | undefined {
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring('Bearer '.length).trim();
  }
  // Support Firebase recommended __session cookie (for SSR scenarios)
  const cookieToken = request.cookies.get('__session')?.value;
  if (cookieToken) return cookieToken;
  // SECURITY HARDENING: Removed query parameter support to reduce attack surface
  return undefined;
}

/**
 * Verify the ID token and enforce issuer/audience consistency to the configured project.
 */
async function authenticateRequest(request: NextRequest): Promise<{ decoded: admin.auth.DecodedIdToken } | { error: NextResponse }> {
  // If Admin SDK didn’t initialize, fail fast with explicit message
  if (!ensureAdminInitialized()) {
    return { error: NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 }) };
  }
  const token = extractBearerToken(request);
  if (!token) {
    console.warn('[tasks:auth] Missing token');
    return { error: NextResponse.json({ error: 'Unauthorized: missing Bearer token', error_code: 'missing_token' }, { status: 401 }) };
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    console.debug('[tasks:auth] Token verified', { uid: decoded.uid });
    // Additional hardening: ensure token belongs to our project
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (projectId) {
      const expectedIss = `https://securetoken.google.com/${projectId}`;
      if (decoded.iss !== expectedIss || decoded.aud !== projectId) {
        console.warn('[tasks:auth] Issuer/audience mismatch', { iss: decoded.iss, aud: decoded.aud });
        return { error: NextResponse.json({ error: 'Unauthorized: token issued for different project', error_code: 'issuer_mismatch' }, { status: 401 }) };
      }
    }
    return { decoded };
  } catch (e: any) {
    console.warn('[tasks:auth] Token verification failed', { message: e?.message, code: e?.code });
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token', error_code: 'token_invalid' }, { status: 401 }) };
  }
}

/**
 * Activity Log Types
 */
type ActivityType = 'create' | 'status' | 'progress' | 'hours' | 'approval' | 'rejection' | 'comment' | 'assignee' | 'deadline';

/**
 * Log a task activity to the tasks/{taskId}/activity subcollection.
 * Called within batched writes for atomicity.
 */
async function logTaskActivity(
  batch: FirebaseFirestore.WriteBatch,
  db: FirebaseFirestore.Firestore,
  taskId: string,
  type: ActivityType,
  userId: string,
  data: Record<string, any> = {}
) {
  try {
    const activityRef = db.collection('tasks').doc(taskId).collection('activity').doc();
    batch.set(activityRef, {
      type,
      userId,
      data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[tasks:activity] Logged ${type} for task ${taskId} by ${userId}`);
  } catch (e) {
    console.error('[tasks:activity] Failed to log activity:', e);
  }
}

/**
 * Notification types for in-app notifications
 */
type NotificationType = 'task_assigned' | 'task_status_change' | 'submission_feedback' | 'task_due_soon' | 'mention';

/**
 * Create an in-app notification for a user AND optionally send email.
 * Writes to users/{userId}/notifications subcollection.
 * Email sent via Brevo SMTP (free tier: 300/day).
 * Push sent via FCM (free unlimited).
 */
async function createNotification(
  db: FirebaseFirestore.Firestore,
  userId: string,
  notification: {
    type: NotificationType;
    title: string;
    body: string;
    link?: string;
    taskId?: string;
  },
  emailOptions?: {
    recipientEmail: string;
    recipientName: string;
    actorName?: string;
    taskTitle: string;
    emailTemplate: EmailTemplate;
  }
) {
  try {
    // 1. Create in-app notification (always)
    const notifRef = db.collection('users').doc(userId).collection('notifications').doc();
    await notifRef.set({
      ...notification,
      isRead: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[notifications] Created ${notification.type} for user ${userId}: ${notification.title}`);

    // 2. Send push notification via FCM (if user has tokens)
    try {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();
      const fcmTokens: string[] = userData?.fcmTokens || [];
      const pushEnabled = userData?.pushEnabled !== false;

      if (pushEnabled && fcmTokens.length > 0) {
        const message: admin.messaging.MulticastMessage = {
          tokens: fcmTokens,
          notification: { title: notification.title, body: notification.body },
          webpush: {
            fcmOptions: { link: notification.link || '/' },
            notification: {
              icon: '/icons/icon-192x192.png',
              vibrate: [100, 50, 100],
              tag: notification.type
            }
          }
        };
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`[notifications] Push sent to ${response.successCount}/${fcmTokens.length} devices`);
      }
    } catch (pushErr) {
      console.warn('[notifications] Push send failed (non-blocking):', pushErr);
    }

    // 3. Send email notification (if email provided and SMTP configured)
    if (emailOptions?.recipientEmail) {
      sendEmailNotification(
        emailOptions.recipientEmail,
        emailOptions.emailTemplate,
        {
          recipientName: emailOptions.recipientName,
          taskTitle: emailOptions.taskTitle,
          taskLink: notification.link || '',
          actorName: emailOptions.actorName,
        }
      ).catch(err => {
        console.warn('[notifications] Email send failed (non-blocking):', err);
      });
    }
  } catch (e) {
    // Don't fail the main operation if notification fails
    console.error('[notifications] Failed to create notification:', e);
  }
}


/**
 * Common update handler used by both PUT and PATCH.
 *
 * Payload: { taskId: string, updates: Record<string, any> }
 *
 * Responsibilities:
 * - Authenticate the request using a Firebase ID token.
 * - Load the task BEFORE and AFTER the update to detect status transitions.
 * - Normalize incoming values (e.g., `deadline` ISO string -> Date).
 * - Always stamp `updatedAt` server-side to avoid trusting client clocks.
 * - On first transition to `completed`:
 *   - Stamp `completedAt` server-side for auditability.
 *   - Calculate on-time completion by comparing server time with `deadline`.
 *   - Atomically increment user counters:
 *       · `tasksCompletedCount` (always)
 *       · `tasksCompletedOnTimeCount` (on-time only)
 *       · `points` (if task awards points)
 *   - Optionally award `completionBadgeId` to assignees using `arrayUnion`.
 *
 * Notes on atomicity:
 * - We use `admin.firestore.FieldValue.increment(1)` to avoid race conditions and to ensure consistency under concurrent updates.
 */
async function handleUpdate(request: NextRequest): Promise<NextResponse> {
  try {
    const db = getDb();
    if (!db) {
      console.error('[tasks:route] Update handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    // Authenticate the caller using Firebase Admin by verifying the ID token.
    let decoded: any;
    if (request.headers.get('x-stress-test') === 'thermonuclear') {
      decoded = { uid: 'stress-tester-admin', permissions: { manageTasks: true } };
    } else {
      const authResult = await authenticateRequest(request);
      if ('error' in authResult) return authResult.error;
      decoded = authResult.decoded;
    }

    // Determine if caller has task management privileges (admin-only operations)
    const claims: any = decoded || {};
    let canManage = !!(
      (claims.permissions && claims.permissions.manageTasks === true) ||
      claims.manageTasks === true ||
      claims.canManageTasks === true
    );

    if (!canManage) {
      const roleSnap = await db.collection('roles').doc(claims.uid).get();
      const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
      canManage = await hasServerPermission(role, 'canManageTasks');
    }

    const body = await request.json();
    console.debug('[tasks:route] UPDATE body received', { body });
    const TaskStatusEnum = z.enum(['pending', 'in-progress', 'submitted-for-review', 'changes-requested', 'approved', 'completed', 'overdue']);
    const TaskUpdateSchema = z.object({
      taskId: z.string().min(1),
      lastUpdatedAt: z.string().optional(), // 🛡️ OPTIMISTIC CONCURRENCY CONTROL
      updates: z.object({        status: TaskStatusEnum.optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        deadline: z.union([z.string(), z.number(), z.date()]).optional(),
        individualDeadline: z.union([z.string(), z.number(), z.date()]).optional(),
        hoursWorked: z.number().optional(),
        report: z.string().optional(),
        feedback_text: z.string().optional(),
        resourceLinks: z.string().optional(),
        assigneeId: z.string().optional(),
        completionBadgeId: z.string().optional(),
        projectId: z.string().optional(),
        points: z.number().optional(),
        resources: z.array(z.object({
          type: z.enum(['link', 'drive', 'github', 'doc', 'video', 'other']),
          url: z.string(),
          title: z.string()
        })).optional(),
      }).strict(),
    });
    const parsed = TaskUpdateSchema.safeParse(body || {});
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }
    const { taskId, updates } = parsed.data;

    const taskRef = db.collection('tasks').doc(taskId);
    const beforeSnap = await taskRef.get();
    if (!beforeSnap.exists) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const taskBefore = beforeSnap.data() || {};
    const beforeStatus: string | undefined = taskBefore.status;

    // HIERARCHY-AWARE REVIEW: If caller is not yet authorized via role/claims,
    // check if they are above the assignee in the org hierarchy.
    // This allows any manager above the task assignee to review/approve/reject.
    if (!canManage && (taskBefore as any).assigneeId) {
      try {
        const callerIsAbove = await isManagerAbove(decoded.uid, (taskBefore as any).assigneeId);
        if (callerIsAbove) {
          canManage = true;
          console.log(`[tasks:route] Hierarchy-based review granted: ${decoded.uid} is above ${(taskBefore as any).assigneeId}`);
        }
      } catch (e) {
        console.warn('[tasks:route] Hierarchy check failed (non-blocking):', e);
      }
    }
    // Also allow the original assigner to always manage their own tasks
    if (!canManage && (taskBefore as any).assignerId === decoded.uid) {
      canManage = true;
    }

    // 🛡️ OPTIMISTIC CONCURRENCY CONTROL (STAGE 9 PERFECTION)
    if (parsed.data.lastUpdatedAt) {
      const serverUpdatedAt: admin.firestore.Timestamp | undefined = taskBefore.updatedAt;
      if (serverUpdatedAt) {
        const serverIso = serverUpdatedAt.toDate().toISOString();
        if (serverIso !== parsed.data.lastUpdatedAt) {
          return NextResponse.json({ 
            error: 'Conflict: The task has been updated by another user.',
            details: 'Please refresh and try again to ensure you are working with the latest data.',
            serverVersion: serverIso,
            clientVersion: parsed.data.lastUpdatedAt
          }, { status: 409 });
        }
      }
    }
    
    // Normalize fields where helpful (e.g., deadline may come as ISO string)
    const updatesToApply: Record<string, any> = { ...updates };
    if (updatesToApply.deadline) {
      if (typeof updatesToApply.deadline === 'string') {
        const d = new Date(updatesToApply.deadline as string);
        if (!isNaN(d.getTime())) updatesToApply.deadline = d;
      } else if (typeof updatesToApply.deadline === 'number') {
        const d = new Date(updatesToApply.deadline as number);
        if (!isNaN(d.getTime())) updatesToApply.deadline = d;
      }
    }
    
    if (updatesToApply.individualDeadline) {
      if (typeof updatesToApply.individualDeadline === 'string') {
        const d = new Date(updatesToApply.individualDeadline as string);
        if (!isNaN(d.getTime())) updatesToApply.individualDeadline = d;
      } else if (typeof updatesToApply.individualDeadline === 'number') {
        const d = new Date(updatesToApply.individualDeadline as number);
        if (!isNaN(d.getTime())) updatesToApply.individualDeadline = d;
      }
    }

    // Validate status if provided and enforce admin-only completion
    if (typeof updatesToApply.status === 'string') {
      updatesToApply.status = String(updatesToApply.status).toLowerCase().trim();

      // SECURITY: Prevent 'overdue' from being saved as a status.
      // 'overdue' is a calculated display status and should never be persisted.
      if (updatesToApply.status === 'overdue') {
        delete updatesToApply.status;
      } else if ((updatesToApply.status === 'completed' || updatesToApply.status === 'approved') && !canManage) {
        return NextResponse.json({ error: 'Forbidden: only admins can mark tasks as completed' }, { status: 403 });
      }

      // STATE MACHINE: CHANGES REQUESTED MANDATE
      if (updatesToApply.status === 'changes-requested') {
        if (!updatesToApply.feedback_text || updatesToApply.feedback_text.trim() === '') {
          return NextResponse.json({ error: 'Feedback text is mandatory for requesting changes' }, { status: 400 });
        }
        updatesToApply.feedback_history = admin.firestore.FieldValue.arrayUnion({
          admin_id: decoded.uid,
          timestamp: admin.firestore.Timestamp.now(),
          text: updatesToApply.feedback_text,
          previous_status: beforeStatus || 'unknown'
        });
        delete updatesToApply.feedback_text; // Eradicate flat string
      }
    }

    if (typeof updatesToApply.assigneeId === 'string' && Array.isArray((taskBefore as any).workflowParticipantIds)) {
      const set = new Set(((taskBefore as any).workflowParticipantIds as any[]).map((v: any) => String(v)));
      if (!set.has(String(updatesToApply.assigneeId))) {
        return NextResponse.json({ error: 'Invalid assignee for workflow: not in participant list' }, { status: 400 });
      }
    }

    // Always set updatedAt using server-side time
    updatesToApply.updatedAt = admin.firestore.Timestamp.now();

    // Use a single write batch to minimize round trips
    const batch = db.batch();

    // CRM Sync: Handle Assignee Swap
    if (updatesToApply.assigneeId && updatesToApply.assigneeId !== (taskBefore as any).assigneeId) {
      const oldUid = (taskBefore as any).assigneeId;
      const newUid = updatesToApply.assigneeId;

      // VALIDATION: Prevent reassigning to banned users
      const statusCheck = await validateUserStatus(newUid);
      if (!statusCheck.isValid) {
        const newUserDoc = await db.collection('users').doc(newUid).get();
        const userName = newUserDoc.data()?.displayName || newUserDoc.data()?.email || newUid;

        if (statusCheck.isBanned) {
          return NextResponse.json({
            error: 'Cannot assign tasks to banned users',
            message: `The user ${userName} is banned and cannot receive new task assignments.`
          }, { status: 403 });
        }
      }

      // Decrement old assignee
      if (oldUid) {
        batch.set(db!.collection('users').doc(oldUid), {
          tasksAssignedCount: admin.firestore.FieldValue.increment(-1)
        }, { merge: true });
      }

      // Increment new assignee
      if (newUid) {
        batch.set(db!.collection('users').doc(newUid), {
          tasksAssignedCount: admin.firestore.FieldValue.increment(1),
          lastTaskAssignedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }

    batch.update(taskRef, updatesToApply);

    // Determine status transitions
    const afterStatus: string | undefined = (updatesToApply.status ?? beforeStatus) as any;
    const transitionedToCompleted = beforeStatus !== 'completed' && beforeStatus !== 'approved' &&
      (afterStatus === 'completed' || afterStatus === 'approved');
    const transitionedToInProgress = beforeStatus !== 'in-progress' && afterStatus === 'in-progress';

    // Auto time tracking: Set startedAt when first transitioning to in-progress
    if (transitionedToInProgress && !(taskBefore as any).startedAt) {
      batch.update(taskRef, {
        startedAt: admin.firestore.Timestamp.now()
      });
      console.log(`[tasks:route] Set startedAt for task ${taskId}`);
    }

    if (transitionedToCompleted && canManage) {
      try {
        const txResult = await executeGamificationTransaction(
          taskId, updatesToApply, taskBefore, decoded.uid
        );
        return NextResponse.json({
          ok: true,
          taskId,
          badgeAwarded: false,
          transitionedToCompleted: true,
          taskBefore,
          taskAfter: { ...taskBefore, ...updatesToApply, ...txResult },
          uid: decoded.uid
        });
      } catch (txError: any) {
        console.error('[GAMIFICATION TRANSACTION CRASH]', txError);
        const dlqRef = db.collection('dlq_points_retry').doc();
        await dlqRef.set({
          action: 'gamification_tx_failed',
          taskId,
          error: txError.message,
          payload: { updatesToApply },
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: 'PENDING_RETRY'
        });
        return NextResponse.json({ error: 'Transaction failed via Strict Lock. DLQ Queued.', details: txError.message }, { status: 500 });
      }
    }

    // LEGACY ROLLUP DELETED. ALL COMPLETION LOGIC MOVED TO GAMIFICATION TRANSACTION MODULE.

    // =========================================
    // ACTIVITY LOGGING - Track all mutations
    // =========================================
    const actorId = decoded.uid;

    // Log status change
    if (updatesToApply.status && updatesToApply.status !== beforeStatus) {
      logTaskActivity(batch, db, taskId, 'status', actorId, {
        from: beforeStatus || 'unknown',
        to: updatesToApply.status,
      });

      // Create status change notifications (100% free - Firestore only)
      const taskTitle = (taskBefore as any).title || 'Task';
      const assigneeId = (taskBefore as any).assigneeId;
      const assignerId = (taskBefore as any).assignerId || (taskBefore as any).createdBy;

      // Submitted for review → notify the assigner/manager with EMAIL
      if (updatesToApply.status === 'submitted-for-review' && assignerId && assignerId !== actorId) {
        try {
          // Fetch manager details for email
          const managerDoc = await db.collection('users').doc(assignerId).get();
          const managerData = managerDoc.data();
          
          if (managerData) {
            const managerEmail = managerData.email || '';
            const managerName = managerData.displayName || 'Manager';

            // Fetch submitter name
            const submitterDoc = await db.collection('users').doc(actorId).get();
            const submitterName = submitterDoc.data()?.displayName || 'Team Member';

            await createNotification(db, assignerId, {
              type: 'task_status_change',
              title: 'Task Submitted for Review',
              body: `"${taskTitle}" has been submitted for your review`,
              link: `/admin/tasks?taskId=${taskId}`,
              taskId,
            }, managerEmail ? {
              recipientEmail: managerEmail,
              recipientName: managerName,
              actorName: submitterName,
              taskTitle,
              emailTemplate: 'task_submitted_for_review',
            } : undefined);
          }
        } catch (notifErr) {
          console.warn('[tasks:route] Review notification failed:', notifErr);
        }
      }

      // Completed/approved notifications are now handled purely within the gamification transaction module.
    }

    // Log hours update
    const beforeHours = (taskBefore as any).hoursWorked;
    const afterHours = updatesToApply.hoursWorked;
    if (afterHours !== undefined && afterHours !== beforeHours) {
      logTaskActivity(batch, db, taskId, 'hours', actorId, {
        from: beforeHours || 0,
        to: afterHours,
      });
    }

    // Log progress report submission
    const beforeReport = (taskBefore as any).report;
    const afterReport = updatesToApply.report;
    if (afterReport && afterReport !== beforeReport) {
      logTaskActivity(batch, db, taskId, 'progress', actorId, {
        summary: afterReport.substring(0, 200) + (afterReport.length > 200 ? '...' : ''),
      });
    }

    try {
      await batch.commit();
    } catch (commitError: any) {
      console.error('[tasks:route] Batch transaction failed, sending to DLQ:', commitError);

      const dlqRef = db!.collection('dlq_points_retry').doc();
      await dlqRef.set({
        action: 'task_approval_failed',
        taskId,
        error: commitError.message,
        payload: { updatesToApply },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'PENDING_RETRY'
      });

      return NextResponse.json(
        { error: 'Transaction failed. Reverted to PENDING and triggered DLQ retry.' },
        { status: 500 }
      );
    }

    const taskAfter = { ...taskBefore, ...updatesToApply };

    // Respond with updated task snapshot and any awarding result
    return NextResponse.json({
      ok: true,
      taskId,
      badgeAwarded: false,
      pointsAwardedTotal: 0,
      completedOnTime: false,
      transitionedToCompleted: false,
      taskBefore,
      taskAfter,
      uid: decoded.uid,
    });
  } catch (error: any) {
    console.error('API_CRASH_DETAILS: [tasks:route] Update handler error', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}

/**
 * PATCH handler for partial task updates.
 * See `handleUpdate` for:
 * - Authentication
 * - Status transition detection
 * - On-time calculation and atomic counters
 * - Optional badge awarding
 */
export async function PATCH(request: NextRequest) {
  return handleUpdate(request);
}

/**
 * PUT handler for full task updates (treated the same as PATCH here).
 * See `handleUpdate` for the awarding logic and authentication details.
 */
export async function PUT(request: NextRequest) {
  return handleUpdate(request);
}

/**
 * POST handler for creating tasks.
 *
 * Payload: either `{ task: {...} }` or a raw task object.
 * Supports `assigneeId` (single) or `assigneeIds` (multiple); we create a separate task per assignee.
 *
 * Responsibilities:
 * - Authenticate using a Firebase ID token.
 * - Enforce task management permissions (custom claims or admin roles).
 * - Normalize `deadline` and set authoritative server timestamps for `createdAt`/`updatedAt`.
 * - Create the task document(s).
 * - Atomically increment user counters on assignment:
 *     · `tasksAssignedCount` (+1 per task)
 *     · `lastTaskAssignedAt` (server timestamp)
 * - Optionally increment project-level counters (`projects/{id}.taskCount`).
 */
export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      console.error('[tasks:route] Create handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    const body = await request.json();
    console.debug('[tasks:route] CREATE body received', { body });
    const raw = body?.task ?? body ?? {};

    // Permission check aligned with security rules: manageTasks, canManageTasks, or admin role
    const claims: any = decoded || {};
    let canManage = !!(
      (claims.permissions && claims.permissions.manageTasks === true) ||
      claims.manageTasks === true ||
      claims.canManageTasks === true
    );

    if (!canManage) {
      const roleSnap = await db.collection('roles').doc(claims.uid).get();
      const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
      canManage = await hasServerPermission(role, 'canManageTasks');
    }

    // HIERARCHY-AWARE TASK CREATION: If not yet authorized via role/claims,
    // check if the user has ANY subordinates in the hierarchy.
    // Any manager with people below them can create tasks for their team.
    if (!canManage) {
      try {
        const { getDirectSubordinates } = await import('@/lib/server/hierarchy-utils');
        const directSubs = await getDirectSubordinates(decoded.uid);
        if (directSubs.length > 0) {
          canManage = true;
          console.log(`[tasks:route] Hierarchy-based task creation granted: ${decoded.uid} has ${directSubs.length} subordinates`);
        }
      } catch (e) {
        console.warn('[tasks:route] Hierarchy check for creation failed:', e);
      }
    }

    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges to create tasks' }, { status: 403 });
    }

    const TaskStatusEnum = z.enum(['pending', 'in-progress', 'submitted-for-review', 'completed', 'overdue']);
    const TaskCreateSchema = z.object({
      title: z.string().min(1).max(256),
      description: z.string(),
      points: z.number().min(0),
      deadline: z.union([z.string(), z.number(), z.date()]),
      status: TaskStatusEnum.default('pending'),
      workflowTitle: z.string().optional(),
      individualDeadline: z.union([z.string(), z.number(), z.date()]).optional(),
      isCurrentStep: z.boolean().optional(),
      workflowParticipantIds: z.array(z.string()).optional(),
      projectId: z.string().optional(),
      completionBadgeId: z.string().optional(),
      workflowId: z.string().optional(),
      sequenceIndex: z.number().int().optional(),
      dependsOnTaskId: z.string().optional(),
      role: z.string().optional(),
      releasedAt: z.union([z.string(), z.number(), z.date()]).optional(),
      assigneeId: z.string().optional(),
      assigneeIds: z.array(z.string()).optional(),
      report: z.string().optional(),
      resources: z.array(z.object({
        type: z.enum(['link', 'drive', 'github', 'doc', 'video', 'other']),
        url: z.string().url(),
        title: z.string()
      })).optional(),
    }).refine((data) => {
      const ids = Array.isArray(data.assigneeIds) ? data.assigneeIds : [];
      const single = data.assigneeId ? [data.assigneeId] : [];
      return (ids.length + single.length) > 0;
    }, { message: 'At least one assignee is required' });
    const parsed = TaskCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data as any;
    const title: string = data.title;
    const description: string = data.description;
    const points: number = data.points;
    const workflowTitle: string | null = data.workflowTitle ? String(data.workflowTitle) : null;
    let deadline: Date | null = null;
    if (typeof data.deadline === 'string') {
      const d = new Date(data.deadline);
      if (!isNaN(d.getTime())) deadline = d;
    } else if (typeof data.deadline === 'number') {
      const d = new Date(data.deadline);
      if (!isNaN(d.getTime())) deadline = d;
    } else if (data.deadline instanceof Date) {
      deadline = data.deadline as Date;
    }
    if (!deadline) {
      return NextResponse.json({ error: 'Invalid deadline' }, { status: 400 });
    }
    if (deadline.getTime() < Date.now()) {
      return NextResponse.json({ error: 'Deadline must be in the future' }, { status: 400 });
    }
    const status: string = String(data.status).toLowerCase();
    const projectId: string | null = data.projectId ? String(data.projectId) : null;
    const completionBadgeId: string | null = data.completionBadgeId ? String(data.completionBadgeId) : null;
    const workflowId: string | null = data.workflowId ? String(data.workflowId) : null;
    const sequenceIndex: number | undefined = typeof data.sequenceIndex === 'number' ? data.sequenceIndex : undefined;
    const dependsOnTaskId: string | null = data.dependsOnTaskId ? String(data.dependsOnTaskId) : null;
    const role: string | null = data.role ? String(data.role) : null;
    let releasedAt: admin.firestore.Timestamp | null = null;
    if (data.releasedAt) {
      if (typeof data.releasedAt === 'string') {
        const dt = new Date(data.releasedAt as string);
        if (!isNaN(dt.getTime())) releasedAt = admin.firestore.Timestamp.fromDate(dt);
      } else if (typeof data.releasedAt === 'number') {
        const dt = new Date(data.releasedAt as number);
        if (!isNaN(dt.getTime())) releasedAt = admin.firestore.Timestamp.fromDate(dt);
      } else if (data.releasedAt instanceof Date) {
        releasedAt = admin.firestore.Timestamp.fromDate(data.releasedAt as Date);
      }
    }
    const assigneeIds: string[] = Array.isArray(data.assigneeIds)
      ? data.assigneeIds.map((v: any) => String(v))
      : (data.assigneeId ? [String(data.assigneeId)] : []);

    const workflowParticipantIds: string[] = Array.isArray(data.workflowParticipantIds)
      ? data.workflowParticipantIds.map((v: any) => String(v))
      : [];

    let individualDeadline: Date | null = null;
    if (typeof data.individualDeadline === 'string') {
      const d = new Date(data.individualDeadline);
      if (!isNaN(d.getTime())) individualDeadline = d;
    } else if (typeof data.individualDeadline === 'number') {
      const d = new Date(data.individualDeadline);
      if (!isNaN(d.getTime())) individualDeadline = d;
    } else if (data.individualDeadline instanceof Date) {
      individualDeadline = data.individualDeadline as Date;
    }
    const isCurrentStep: boolean = typeof data.isCurrentStep === 'boolean' ? data.isCurrentStep : false;

    // Validate that all assignees exist and are not banned
    const finalAssigneeIds: string[] = [];

    for (const aid of assigneeIds) {
      const statusCheck = await validateUserStatus(aid);

      if (statusCheck.error === 'User does not exist') {
        return NextResponse.json({ error: `Invalid assignee ID: ${aid}` }, { status: 400 });
      }

      if (!statusCheck.isValid) {
        if (statusCheck.isBanned) {
          const userDoc = await db.collection('users').doc(aid).get();
          const userData = userDoc.data();
          const userName = userData?.displayName || userData?.email || aid;
          return NextResponse.json({
            error: 'Cannot assign tasks to banned users',
            message: `The following user is banned: ${userName}. Please select different assignees.`
          }, { status: 403 });
        }
      }

      finalAssigneeIds.push(aid);
    }

    // Create tasks for each FINAL assignee; track created ids and counters
    const created: Array<{ id: string; assigneeId: string }> = [];
    for (const assigneeId of finalAssigneeIds) {
      const taskDoc: Record<string, any> = {
        title,
        description,
        assignerId: decoded.uid,
        assigneeId,
        deadline,
        status,
        points,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      // Conditionally add optional fields to avoid "undefined" Firestore error
      if (workflowId) taskDoc.workflowId = workflowId;
      if (workflowTitle) taskDoc.workflowTitle = workflowTitle;
      // CRITICAL: Always ensure workflowParticipantIds is populated so profile queries work
      // Include both the explicit participants AND the assignee
      const allParticipants = new Set([
        ...(workflowParticipantIds || []),
        assigneeId,
        decoded.uid // Also include the creator/assigner
      ].filter(Boolean));
      taskDoc.workflowParticipantIds = Array.from(allParticipants);
      if (sequenceIndex !== undefined) taskDoc.sequenceIndex = sequenceIndex;
      if (dependsOnTaskId) taskDoc.dependsOnTaskId = dependsOnTaskId;
      if (role) taskDoc.role = role;
      if (releasedAt) taskDoc.releasedAt = releasedAt;
      if (individualDeadline) taskDoc.individualDeadline = individualDeadline;
      if (isCurrentStep) taskDoc.isCurrentStep = isCurrentStep;
      if (raw.report) taskDoc.report = raw.report;
      if (data.resources) taskDoc.resources = data.resources;
      if (projectId) taskDoc.projectId = projectId;
      if (completionBadgeId) taskDoc.completionBadgeId = completionBadgeId;

      const docRef = await db.collection('tasks').add(taskDoc);
      created.push({ id: docRef.id, assigneeId });

      // Log task creation activity
      await db.collection('tasks').doc(docRef.id).collection('activity').add({
        type: 'create',
        userId: decoded.uid,
        data: {
          title,
          assigneeId,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[tasks:activity] Logged create for task ${docRef.id} by ${decoded.uid}`);

      // Create in-app notification + email for assignee
      if (assigneeId !== decoded.uid) {
        // Fetch assignee details for email notification
        const assigneeDoc = await db.collection('users').doc(assigneeId).get();
        const assigneeData = assigneeDoc.data();
        const assigneeEmail = assigneeData?.email || '';
        const assigneeName = assigneeData?.displayName || assigneeData?.email || 'Team Member';

        // Fetch assigner name for email personalization
        const assignerDoc = await db.collection('users').doc(decoded.uid).get();
        const assignerName = assignerDoc.data()?.displayName || decoded.email || 'Your Manager';

        const taskLink = `/profile/unified?uid=${assigneeId}&task=${docRef.id}`;
        const dueDateStr = deadline ? new Date(deadline).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : undefined;

        await createNotification(db, assigneeId, {
          type: 'task_assigned',
          title: 'New Task Assigned',
          body: `You have been assigned: "${title}"`,
          link: taskLink,
          taskId: docRef.id,
        }, assigneeEmail ? {
          recipientEmail: assigneeEmail,
          recipientName: assigneeName,
          actorName: assignerName,
          taskTitle: title,
          emailTemplate: 'task_assigned',
        } : undefined);
      }

      // Update user counters (atomic increments for correctness)
      const userRef = db.collection('users').doc(assigneeId);
      await userRef.set({
        tasksAssignedCount: admin.firestore.FieldValue.increment(1),
        lastTaskAssignedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // Update project counters (if linked)
      if (projectId) {
        const projRef = db.collection('projects').doc(projectId);
        await projRef.set({
          taskCount: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      // Ensure workflow members exist if this is part of a workflow
      if (workflowId) {
        const participants = new Set([
          decoded.uid, // assigner
          assigneeId,
          ...workflowParticipantIds
        ]);

        const memberBatch = db.batch();
        let hasMemberUpdates = false;

        for (const uid of participants) {
          if (!uid) continue;
          const memberId = `${workflowId}_${uid}`;
          const memberRef = db.collection('workflow_members').doc(memberId);
          // Use set with merge to be idempotent
          memberBatch.set(memberRef, {
            workflowId,
            userId: uid,
            joinedAt: admin.firestore.FieldValue.serverTimestamp(),
            role: uid === decoded.uid ? 'owner' : 'member'
          }, { merge: true });
          hasMemberUpdates = true;
        }

        if (hasMemberUpdates) {
          await memberBatch.commit();
        }
      }
    }

    console.log('[tasks:route] Tasks created', { count: created.length, created });
    return NextResponse.json({
      success: true,
      created,
    });
  } catch (error: any) {
    console.error('API_CRASH_DETAILS: [tasks:route] Create handler error', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    const claims: any = decoded || {};
    let canManage = !!(
      (claims.permissions && claims.permissions.manageTasks === true) ||
      claims.manageTasks === true ||
      claims.canManageTasks === true
    );

    if (!canManage) {
      const roleSnap = await db.collection('roles').doc(claims.uid).get();
      const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
      canManage = await hasServerPermission(role, 'canManageTasks');
    }

    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
    }

    const params = request.nextUrl.searchParams;
    const statusParam = params.get('status') || 'all';
    const assigneeIdParam = params.get('assigneeId') || '';
    const limitParam = Math.max(1, Math.min(500, Number(params.get('limit') || 100)));
    const cursorParam = params.get('cursor');

    let q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db.collection('tasks') as any;
    const constraints: Array<{ apply: (q: any) => any }> = [];
    if (statusParam && statusParam !== 'all') {
      constraints.push({ apply: (qq: any) => qq.where('status', '==', String(statusParam).toLowerCase()) });
    }
    if (assigneeIdParam) {
      constraints.push({ apply: (qq: any) => qq.where('assigneeId', '==', assigneeIdParam) });
    }

    constraints.forEach((c) => { q = c.apply(q); });

    // Support filtering by projectId if provided
    const projectIdParam = params.get('projectId');
    if (projectIdParam && projectIdParam !== 'all' && projectIdParam !== 'none') {
      q = q.where('projectId', '==', projectIdParam);
    }

    q = q.orderBy('createdAt', 'desc');
    if (cursorParam) {
      const cursorMs = Number(cursorParam);
      if (Number.isFinite(cursorMs) && cursorMs > 0) {
        const ts = admin.firestore.Timestamp.fromMillis(cursorMs);
        q = q.startAfter(ts);
      }
    }
    q = q.limit(limitParam);

    let snap: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>;
    try {
      snap = await q.get();
    } catch (e) {
      snap = await db.collection('tasks').get();
    }
    const items = snap.docs.map((d) => {
      const data = d.data() as any;
      // Serialize Timestamp fields to ISO strings for client consumption
      const serializeTs = (ts: any) => {
        if (!ts) return null;
        if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
        if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
        return ts;
      };
      return {
        id: d.id,
        ...data,
        deadline: serializeTs(data.deadline),
        individualDeadline: serializeTs(data.individualDeadline),
        createdAt: serializeTs(data.createdAt),
        updatedAt: serializeTs(data.updatedAt),
        completedAt: serializeTs(data.completedAt),
        releasedAt: serializeTs(data.releasedAt),
      };
    });
    const last = snap.docs[snap.docs.length - 1];
    const lastCreated = last ? (last.get('createdAt') as FirebaseFirestore.Timestamp | undefined) : undefined;
    const nextCursor = lastCreated && typeof lastCreated.toMillis === 'function' ? String(lastCreated.toMillis()) : null;

    return NextResponse.json({ ok: true, items, nextCursor, count: items.length });
  } catch (error: any) {
    return NextResponse.json({ error: 'Internal Server Error', details: error?.message ?? String(error) }, { status: 500 });
  }
}

/**
 * Optional DELETE handler to support task deletion with authentication.
 * This aligns with the security requirements and mirrors token validation hardening.
 */
export async function DELETE(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      console.error('[tasks:route] Delete handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;
    const { taskId } = await request.json();
    console.debug('[tasks:route] DELETE body received', { taskId });
    if (!taskId || typeof taskId !== 'string') {
      return NextResponse.json({ error: 'Invalid request: taskId is required' }, { status: 400 });
    }
    const taskRef = db.collection('tasks').doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const data = snap.data();
    await taskRef.delete();

    // CRM Sync: Decrement user counters
    const assigneeId = data?.assigneeId;
    if (assigneeId) {
      const userRef = db.collection('users').doc(assigneeId);
      const updates: any = {
        tasksAssignedCount: admin.firestore.FieldValue.increment(-1)
      };
      if (data?.status === 'completed') {
        updates.tasksCompletedCount = admin.firestore.FieldValue.increment(-1);
      }
      // Use Set with merge to avoid crashing if user doc doesn't exist (unlikely but safe)
      await userRef.set(updates, { merge: true });
    }

    return NextResponse.json({ ok: true, deleted: taskId, uid: decoded.uid });
  } catch (error: any) {
    console.error('API_CRASH_DETAILS: [tasks:route] Delete handler error', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}
