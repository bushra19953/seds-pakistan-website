/**
 * notification-read-state — the ONE normalized read-state for personal
 * notifications (MSG30, notification bell).
 *
 * Two spellings coexist in users/{uid}/notifications, and every
 * mark-read write and every count/list reader used to speak only one
 * of them:
 *
 *   - `isRead` — notification-service, tasks, submissions, delegate,
 *     activity, workflows, universal-review, resources/notify,
 *     gamification, leave-notifications, validation-notifications.
 *   - `read` — notification-helper (createNotificationToUser,
 *     createAdminNotification, the shared helper) and the webhooks
 *     task-complete writer. These docs carry NO `isRead` field.
 *
 * The bug that fell out of that split (founder report: the bell
 * "always stays filled even when marked all done"):
 *
 *   - Mark-all-read selected only `isRead === false` docs, so a
 *     `read: false` doc was never written and its unread marker
 *     survived every "mark all done".
 *   - Readers disagreed about the same doc: the badge count
 *     (`isRead === false`) treated a missing `isRead` as READ, while
 *     item styling (truthy `n.isRead`) treated it as UNREAD. A
 *     missing field, an explicit false, and a differently-spelled
 *     field are three different states; the old code confused them.
 *
 * Normalization (state layer only, no shape rewriting — GET payloads
 * keep their stored spelling, so existing shape contracts hold):
 *
 *   - READ iff either field is exactly `true`. A missing field, an
 *     explicit `false`, or a non-boolean value is UNREAD (fail-closed
 *     toward visible: a weird value keeps the item surfaced, never
 *     silently drops it). A doc carrying both fields with conflicting
 *     values (old single-mark residue: `isRead: true` + `read:
 *     false`) reads as READ, because either true wins.
 *   - Every mark-read write uses MARK_NOTIFICATION_READ_UPDATE, which
 *     sets BOTH fields true, so no reader of either spelling can ever
 *     see a marked doc as unread again.
 *   - Creators are deliberately NOT rewritten: they keep writing
 *     their own spelling, and readers + mark-writes now cover both,
 *     so old and new docs of either family behave identically.
 *
 * Consumers (traced end to end): the /api/notifications route (mark
 * selection + mark writes), NotificationCenter (badge count + item
 * styling), the Supa client hook (mark selection + optimistic
 * updates), and the /notifications page (item styling).
 *
 * Deliberately NOT consumers of this helper: the validation
 * resolver (it resolves only its own alert type, which its own
 * writer always spells `isRead`, and its Firestore where-clause
 * cannot express an OR across spellings — a dual-query change is a
 * separate job), the election stub port (a different store), and the
 * toast listener (no read filter by design).
 */

/**
 * Input shape: store docs are untyped (the route's rows are
 * `{ id } & Record<string, unknown>`), while typed consumers carry
 * the two optional fields. The union admits both; a nullish doc is
 * unread, never an error.
 */
export type NotificationReadState =
  | { isRead?: unknown; read?: unknown }
  | Record<string, unknown>
  | null
  | undefined;

/** A notification is read iff either spelling says exactly true. */
export function isNotificationRead(doc: NotificationReadState): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as { isRead?: unknown; read?: unknown };
  return d.isRead === true || d.read === true;
}

/** The complement: missing, false, or non-boolean in both fields. */
export function isNotificationUnread(doc: NotificationReadState): boolean {
  return !isNotificationRead(doc);
}

/** Badge count over a list: the single formula the bell uses. */
export function notificationUnreadCount(
  docs: ReadonlyArray<NotificationReadState> | null | undefined,
): number {
  if (!docs) return 0;
  let count = 0;
  for (const doc of docs) {
    if (isNotificationUnread(doc)) count += 1;
  }
  return count;
}

/**
 * The single mark-read write payload. Spread it into the update
 * (never pass the frozen object itself to a store that mutates its
 * input): { ...MARK_NOTIFICATION_READ_UPDATE }.
 */
export const MARK_NOTIFICATION_READ_UPDATE: Readonly<{ isRead: true; read: true }> =
  Object.freeze({ isRead: true, read: true });
