import { FieldValue } from 'firebase-admin/firestore';

/**
 * Server-side universal_submissions sync for `applications` writes —
 * WS10 (A1/A2/A3 client-direct elimination).
 *
 * REPLICA PARITY (functions-accounting §8): today, a client write to
 * `applications` through firestore-wrapper dispatches to
 * /api/webhooks/dispatch, whose replica routes the collection to
 * handleSubmissionsSyncRoute → executeUniversalSubmissionSync in
 * src/app/api/webhooks/firestore/route.ts (PINNED — not modified).
 * That sync is the write's only downstream replica effect.
 *
 * When the write moves server-side (Admin SDK), no dispatch fires, so
 * the server seam must own the effect explicitly. This module is a
 * faithful port of the replica's `applications` branch ONLY:
 *   globalId  = `applications_${docId}`
 *   type      = 'APPLICATION'
 *   status    = String(after.status || 'PENDING').toUpperCase()
 *   userId    = after.userId || after.user_id
 *   summary   = `Application: ${after.roleAppliedFor ||
 *                after.role_applied_for || after.position ||
 *                'Unknown Role'}`
 *   chapterId = after.chapterId || after.chapter_id, else the user
 *               doc's chapterId
 *   display/photo fall back to the user doc (displayName||name,
 *               photoURL)
 *   created_at = after.createdAt || after.submittedAt ||
 *                after.created_at || serverTimestamp()
 *   set-merge universal_submissions/{globalId} with the replica's
 *   snake_case field names.
 *
 * `after` must be the post-write application document (the same
 * snapshot the wrapper would have captured). Callers pass the doc as
 * read back from the primary store after the write.
 *
 * Never throws: the replica dispatch was fire-and-forget from the
 * client, so a sync failure must not fail the admin action that
 * caused it. Failures are logged.
 */
export async function syncApplicationUniversalSubmission(
  db: any,
  appId: string,
  after: Record<string, any> | null | undefined,
): Promise<void> {
  try {
    if (!after || typeof after !== 'object') return;
    const globalId = `applications_${appId}`;
    const status = String(after.status || 'PENDING').toUpperCase();
    const userId = after.userId || after.user_id;
    const summaryText = `Application: ${
      after.roleAppliedFor || after.role_applied_for || after.position || 'Unknown Role'
    }`;

    let chapterId = after.chapterId || after.chapter_id || null;
    if (!chapterId && userId) {
      try {
        const uDoc = await db.collection('users').doc(userId).get();
        if (uDoc.exists) chapterId = uDoc.data()?.chapterId || null;
      } catch {}
    }

    let userDisplayName = after.userDisplayName || after.name || null;
    let userPhotoURL = after.userPhotoURL || after.photoURL || null;
    if (userId && (!userDisplayName || !userPhotoURL)) {
      try {
        const uDoc = await db.collection('users').doc(userId).get();
        if (uDoc.exists) {
          const u = uDoc.data()!;
          if (!userDisplayName) userDisplayName = u.displayName || u.name || null;
          if (!userPhotoURL) userPhotoURL = u.photoURL || null;
        }
      } catch {}
    }

    const createdAt =
      after.createdAt || after.submittedAt || after.created_at || FieldValue.serverTimestamp();

    await db.collection('universal_submissions').doc(globalId).set(
      {
        global_id: globalId,
        original_ref: `applications/${appId}`,
        type: 'APPLICATION',
        status,
        created_at: createdAt,
        user_id: userId || null,
        user_display_name: userDisplayName || 'Anonymous',
        user_photo_url: userPhotoURL || null,
        chapter_id: chapterId || null,
        summary_text: summaryText,
      },
      { merge: true },
    );
  } catch (err) {
    console.error('[universal-submissions-sync] applications sync failed (non-fatal):', err);
  }
}
