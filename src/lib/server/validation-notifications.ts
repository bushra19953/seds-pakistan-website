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
import {
  mirrorNotificationCreate,
  userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

type NotificationType = 'task_assigned' | 'task_status_change' | 'submission_feedback' | 'task_due_soon' | 'mention';

async function writeInAppNotification(
  db: FirebaseFirestore.Firestore,
  userId: string,
  notification: { type: NotificationType; title: string; body: string; link?: string; taskId?: string }
): Promise<void> {
  const notifRef = db.collection('users').doc(userId).collection('notifications').doc();
  const data = {
    ...notification,
    isRead: false,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
  await notifRef.set(data);
  // Supabase mirror (flag-gated, non-throwing; Firestore stays primary).
  await mirrorNotificationCreate(userNotificationsPath(userId), notifRef.id, data);
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
        title: VALIDATOR_ALERT_TITLE,
        body: `${submitterName} submitted "${opts.taskTitle}" and it is awaiting validation.`,
        link,
        taskId: opts.taskId,
      })
    )
  );
}

export interface AcceptanceRequestOpts {
  taskId: string;
  taskTitle: string;
  assigneeUids: string[];
  assignerName?: string;
  excludeUid?: string;
}

/**
 * Nudge each assignee to accept or decline their newly assigned task.
 * In-app + push only: the task_assigned email path in the create route
 * already carries email copy, so this stays in-app to respect the
 * 1000/day email cap. Non-throwing.
 */
export async function notifyAcceptanceRequest(opts: AcceptanceRequestOpts): Promise<void> {
  const db = getDb();
  if (!db) {
    console.warn('[validation-notifications] No db, skipping acceptance nudge');
    return;
  }
  const recipients = new Set<string>();
  for (const uid of opts.assigneeUids || []) {
    if (uid && uid !== opts.excludeUid) recipients.add(uid);
  }
  if (recipients.size === 0) return;

  const assignerLabel = opts.assignerName || 'Your manager';
  await Promise.all(
    [...recipients].map((uid) =>
      notifyOne(db, uid, {
        type: 'task_status_change',
        title: 'Task Awaiting Your Acceptance',
        body: `${assignerLabel} assigned you "${opts.taskTitle}". Please accept or decline it to confirm.`,
        link: `/profile/unified?uid=${uid}&task=${opts.taskId}`,
        taskId: opts.taskId,
      })
    )
  );
}

export interface DeclineEscalationOpts {
  taskId: string;
  taskTitle: string;
  declinedByUid: string;
  declinedByName?: string;
  assigneeName?: string;
  chainUids: string[];
  assignerId?: string;
}

/**
 * Options for the post-decision notification fan-out (approval / rejection).
 */
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
 * Escalate a declined task to the validator/manager chain above the assignee
 * so it can be reassigned or escalated further. The decliner is excluded;
 * the assigner is included when they are not the decliner. In-app + push
 * only, per the channel policy. Non-throwing.
 */
export async function notifyChainOnDecline(opts: DeclineEscalationOpts): Promise<void> {
  const db = getDb();
  if (!db) {
    console.warn('[validation-notifications] No db, skipping decline escalation');
    return;
  }
  const recipients = new Set<string>();
  for (const uid of opts.chainUids || []) {
    if (uid && uid !== opts.declinedByUid) recipients.add(uid);
  }
  if (opts.assignerId && opts.assignerId !== opts.declinedByUid) {
    recipients.add(opts.assignerId);
  }
  if (recipients.size === 0) return;

  const declinerLabel = opts.declinedByName || 'A team member';
  const assigneeLabel = opts.assigneeName ? ` (assigned to ${opts.assigneeName})` : '';
  const link = `/admin/tasks?taskId=${opts.taskId}`;
  await Promise.all(
    [...recipients].map((uid) =>
      notifyOne(db, uid, {
        type: 'task_status_change',
        title: 'Task Declined - Escalation Needed',
        body: `${declinerLabel} declined "${opts.taskTitle}"${assigneeLabel}. Please reassign it or escalate.`,
        link,
        taskId: opts.taskId,
      })
    )
  );
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

export interface ResolveSubmissionAlertsOpts {
  taskId: string;
  submitterUid: string;
  assignerId?: string;
  validatorUids: string[];
}

/**
 * Title written by notifyValidatorsOnSubmission. It is the only field
 * that distinguishes a validator's "awaiting validation" alert from the
 * other task_status_change notifications that share the same taskId
 * (acceptance nudges, decision notices), so resolution matches on it.
 */
export const VALIDATOR_ALERT_TITLE = 'Task Awaiting Your Validation';

/**
 * Auto-resolve the validators' "awaiting validation" alerts once the
 * submission has been decided (approved or changes-requested). Before
 * this, those alerts only ever cleared by manual mark-read, so decided
 * work kept pinging every validator's inbox forever.
 *
 * Recipients mirror notifyValidatorsOnSubmission exactly (the validator
 * chain minus the submitter and the assigner), so resolution reaches
 * precisely the inboxes the fan-out touched. Resolved alerts are marked
 * read and stamped; the document is kept for history. Non-throwing,
 * like every function in this module.
 */
export async function resolveValidatorSubmissionAlerts(opts: ResolveSubmissionAlertsOpts): Promise<void> {
  const db = getDb();
  if (!db) {
    console.warn('[validation-notifications] No db, skipping validator alert resolution');
    return;
  }
  const recipients = new Set<string>();
  for (const uid of opts.validatorUids || []) {
    if (uid && uid !== opts.submitterUid && uid !== opts.assignerId) recipients.add(uid);
  }
  if (recipients.size === 0) return;

  await Promise.all(
    [...recipients].map(async (uid) => {
      try {
        const snap = await db
          .collection('users')
          .doc(uid)
          .collection('notifications')
          .where('taskId', '==', opts.taskId)
          .get();
        const resolutions = snap.docs
          .filter((doc) => {
            const n = doc.data();
            return n.type === 'task_status_change' && n.title === VALIDATOR_ALERT_TITLE && n.isRead === false;
          })
          .map((doc) =>
            doc.ref.update({
              isRead: true,
              resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
              resolution: 'validation_decided',
            })
          );
        await Promise.all(resolutions);
      } catch (e) {
        console.error('[validation-notifications] Failed to resolve validator alerts for', uid, e);
      }
    })
  );
}
