/**
 * Hierarchical Validation Notifications (Server-side)
 *
 * Notifies eligible validators when a task is submitted and notifies the
 * submitter (and assigner) when a validation decision is made.
 *
 * Channel policy: chain validators get in-app + push only. Email is
 * reserved for the assigner path (existing behavior) to respect the
 * 1000/day email cap. Every function is non-throwing: a notification
 * failure must never fail the approval itself.
 */

import { getDb, admin } from '@/lib/server/firebase-admin';

type NotificationType = 'task_assigned' | 'task_status_change' | 'submission_feedback' | 'task_due_soon' | 'mention';

async function writeInAppNotification(
  db: FirebaseFirestore.Firestore,
  userId: string,
  notification: { type: NotificationType; title: string; body: string; link?: string; taskId?: string }
): Promise<void> {
  const notifRef = db.collection('users').doc(userId).collection('notifications').doc();
  await notifRef.set({
    ...notification,
    isRead: false,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function sendPush(
  db: FirebaseFirestore.Firestore,
  userId: string,
  title: string,
  body: string,
  link?: string
): Promise<void> {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    const fcmTokens: string[] = userData?.fcmTokens || [];
    const pushEnabled = userData?.pushEnabled !== false;
    if (!pushEnabled || fcmTokens.length === 0) return;
    const message: admin.messaging.MulticastMessage = {
      tokens: fcmTokens,
      notification: { title, body },
      webpush: {
        fcmOptions: { link: link || '/' },
        notification: { icon: '/icons/icon-192x192.png', tag: 'task_status_change' },
      },
    };
    await admin.messaging().sendEachForMulticast(message);
  } catch (pushErr) {
    console.warn('[validation-notifications] Push send failed (non-blocking):', pushErr);
  }
}

async function notifyOne(
  db: FirebaseFirestore.Firestore,
  userId: string,
  notification: { type: NotificationType; title: string; body: string; link?: string; taskId?: string }
): Promise<void> {
  try {
    await writeInAppNotification(db, userId, notification);
    await sendPush(db, userId, notification.title, notification.body, notification.link);
  } catch (e) {
    console.error('[validation-notifications] Failed to notify', userId, e);
  }
}

export interface SubmissionNotifyOpts {
  taskId: string;
  taskTitle: string;
  submitterUid: string;
  submitterName?: string;
  validatorUids: string[];
  assignerId?: string;
}

/**
 * Fan out to every eligible validator when a task is submitted.
 * In-app + push only. The assigner keeps the existing email path in the
 * tasks route, so they are skipped here to avoid a double ping.
 */
export async function notifyValidatorsOnSubmission(opts: SubmissionNotifyOpts): Promise<void> {
  const db = getDb();
  if (!db) {
    console.warn('[validation-notifications] No db, skipping validator fan-out');
    return;
  }
  const recipients = new Set<string>();
  for (const uid of opts.validatorUids || []) {
    if (uid && uid !== opts.submitterUid && uid !== opts.assignerId) recipients.add(uid);
  }
  if (recipients.size === 0) return;

  const submitterName = opts.submitterName || 'A team member';
  const link = `/admin/tasks?taskId=${opts.taskId}`;
  await Promise.all(
    [...recipients].map((uid) =>
      notifyOne(db, uid, {
        type: 'task_status_change',
        title: 'Task Awaiting Your Validation',
        body: `${submitterName} submitted "${opts.taskTitle}" and it is awaiting validation.`,
        link,
        taskId: opts.taskId,
      })
    )
  );
}

export interface DecisionNotifyOpts {
  taskId: string;
  taskTitle: string;
  submitterUid: string;
  assignerId?: string;
  decision: 'approved' | 'rejected';
  validatorUid: string;
  validatorRoleLabel: string;
  reason?: string;
}

/**
 * Notify the submitter (and the assigner, when different from the validator)
 * after a validation decision.
 */
export async function notifyOnDecision(opts: DecisionNotifyOpts): Promise<void> {
  const db = getDb();
  if (!db) {
    console.warn('[validation-notifications] No db, skipping decision notifications');
    return;
  }
  const link = `/admin/tasks?taskId=${opts.taskId}`;
  const approved = opts.decision === 'approved';

  const submitterBody = approved
    ? `"${opts.taskTitle}" was approved by ${opts.validatorRoleLabel}.`
    : `"${opts.taskTitle}" needs changes: ${(opts.reason || 'No reason given').slice(0, 200)}`;

  const jobs: Promise<void>[] = [
    notifyOne(db, opts.submitterUid, {
      type: 'submission_feedback',
      title: approved ? 'Task Approved' : 'Changes Requested',
      body: submitterBody,
      link,
      taskId: opts.taskId,
    }),
  ];

  if (opts.assignerId && opts.assignerId !== opts.validatorUid && opts.assignerId !== opts.submitterUid) {
    jobs.push(
      notifyOne(db, opts.assignerId, {
        type: 'task_status_change',
        title: approved ? 'Assigned Task Approved' : 'Assigned Task Needs Changes',
        body: approved
          ? `${opts.validatorRoleLabel} approved "${opts.taskTitle}".`
          : `${opts.validatorRoleLabel} requested changes on "${opts.taskTitle}".`,
        link,
        taskId: opts.taskId,
      })
    );
  }

  await Promise.all(jobs);
}
