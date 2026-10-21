/**
 * Cadetship stanza for the governance cron (phase2_spec.md Sections F.3,
 * F.4, F.5, F.7; hosted by Workstream D's daily governance cron as the
 * cadetshipWeek8 stanza - this module is the stanza; the host route lives
 * with Workstream D).
 *
 * One pass, fully idempotent, every effect keyed on stored state + stamps:
 *   1. Sprint sweep: a completed task inside the probation window fills
 *      items.sprintTask (detectedBy 'auto') - assigneeId == personUid OR
 *      assigneeIds contains personUid, status completed/approved,
 *      completedAt within [startedAt, probationEnd | extendedTo].
 *   2. Transitions: active past probationEnd -> under_review; extended
 *      past extendedTo -> reviewDue. Entering review notifies the Chapter
 *      President, the resolved team lead, and the NMD.
 *   3. ONE evaluation reminder at review + 7 days when evaluations are
 *      still incomplete (evaluationReminderSentAt stamp; once, never a
 *      third).
 *   4. Membership-class write retry for confirmed records carrying
 *      membershipClassWritePending.
 *
 * Flag-off (cadetshipLive) returns a skipped summary and writes nothing.
 * There is NO dedupeKey in notificationService, so idempotency rests on
 * the state transitions and stamps themselves, exactly as designed here.
 */

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { notificationService } from '@/lib/server/notification-service';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { setMembershipClass } from './dues-adapter';
import { resolveRoleHolders } from '@/lib/server/compliance-role-holders';
import { cadetshipFromFirestore, asDate } from './serialize';
import { CP_ROLE, NMD_ROLE, resolveTeamLeadUid } from './access';
import type { CadetshipDoc } from '@/lib/cadetship/types';

export interface CadetshipStanzaSummary {
  skipped: boolean;
  sprintDetected: number;
  transitionedToReview: number;
  reviewDueSet: number;
  remindersSent: number;
  classRetries: number;
  classRetrySucceeded: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function zeroSummary(skipped: boolean): CadetshipStanzaSummary {
  return {
    skipped,
    sprintDetected: 0,
    transitionedToReview: 0,
    reviewDueSet: 0,
    remindersSent: 0,
    classRetries: 0,
    classRetrySucceeded: 0,
  };
}

async function notifyReviewDue(
  db: admin.firestore.Firestore,
  doc: CadetshipDoc,
  reminder: boolean,
): Promise<void> {
  const recipients = new Set<string>();
  const cps = await resolveRoleHolders(CP_ROLE, doc.chapterId);
  cps.forEach((u) => recipients.add(u));
  const nmds = await resolveRoleHolders(NMD_ROLE);
  nmds.forEach((u) => recipients.add(u));
  const lead = await resolveTeamLeadUid(db, doc);
  if (lead) recipients.add(lead);

  let name = doc.personUid;
  try {
    const userSnap = await db.collection('users').doc(doc.personUid).get();
    const displayName = userSnap.data()?.displayName;
    if (typeof displayName === 'string' && displayName) name = displayName;
  } catch {
    // Name is cosmetic; the uid fallback keeps the notification factual.
  }

  const payload = {
    type: reminder ? 'cadetship_evaluation_reminder' : 'cadetship_review_due',
    title: reminder ? 'Cadetship evaluations still outstanding' : 'Cadetship review due',
    body: reminder
      ? `Evaluations are still incomplete for ${name}, ${doc.cohortId}.`
      : `Cadetship review due: ${name}, ${doc.cohortId}.`,
    link: '/admin/cadetships',
  };
  for (const uid of recipients) {
    await notificationService.send(uid, payload, 'P2');
  }
}

async function sweepSprintTask(
  db: admin.firestore.Firestore,
  doc: CadetshipDoc,
): Promise<{ taskId: string; completedAt: Date } | null> {
  const windowEnd = doc.extendedTo ?? doc.probationEnd;
  const candidates = new Map<string, Record<string, any>>();

  const bySingle = await db.collection('tasks').where('assigneeId', '==', doc.personUid).get();
  bySingle.forEach((d) => candidates.set(d.id, d.data() as Record<string, any>));
  const byArray = await db
    .collection('tasks')
    .where('assigneeIds', 'array-contains', doc.personUid)
    .get();
  byArray.forEach((d) => candidates.set(d.id, d.data() as Record<string, any>));

  let best: { taskId: string; completedAt: Date } | null = null;
  for (const [taskId, task] of candidates) {
    if (task.status !== 'completed' && task.status !== 'approved') continue;
    const completedAt = asDate(task.completedAt);
    if (!completedAt) continue;
    if (completedAt.getTime() < doc.startedAt.getTime()) continue;
    if (completedAt.getTime() > windowEnd.getTime()) continue;
    if (!best || completedAt.getTime() < best.completedAt.getTime()) {
      best = { taskId, completedAt };
    }
  }
  return best;
}

export async function runCadetshipStanza(now: Date): Promise<CadetshipStanzaSummary> {
  const live = await isPhase2Live('cadetshipLive').catch(() => false);
  if (!live) return zeroSummary(true);
  const db = getDb();
  if (!db) return zeroSummary(true);

  const summary = zeroSummary(false);
  const snap = await db.collection('cadetships').get();

  for (const rawDoc of snap.docs) {
    const doc = cadetshipFromFirestore(rawDoc.id, rawDoc.data() as Record<string, any>);
    const ref = rawDoc.ref;
    const stamp = admin.firestore.FieldValue.serverTimestamp();

    // 4. Class-write retry (confirmed records only).
    if (doc.status === 'confirmed' && doc.membershipClassWritePending) {
      summary.classRetries += 1;
      try {
        await setMembershipClass(doc.personUid, 'Full', {
          via: 'cadetship_confirmation',
          cadetshipId: doc.id,
        });
        await ref.update({ membershipClassWritePending: false, updatedAt: stamp, updatedBy: 'system:cadetship-stanza' });
        summary.classRetrySucceeded += 1;
      } catch {
        // Still pending; the next run retries. Never a silent success.
      }
      continue;
    }

    if (doc.status !== 'active' && doc.status !== 'under_review' && doc.status !== 'extended') {
      continue;
    }

    // 1. Sprint sweep.
    if (!doc.items.sprintTask.taskId) {
      const found = await sweepSprintTask(db, doc);
      if (found) {
        const items = {
          ...doc.items,
          sprintTask: { taskId: found.taskId, completedAt: found.completedAt, detectedBy: 'auto' as const },
        };
        await ref.update({ items, updatedAt: stamp, updatedBy: 'system:cadetship-stanza' });
        doc.items = items;
        summary.sprintDetected += 1;
      }
    }

    // 2. Transitions.
    let inReview = doc.status === 'under_review';
    if (doc.status === 'active' && now.getTime() >= doc.probationEnd.getTime()) {
      await ref.update({ status: 'under_review', updatedAt: stamp, updatedBy: 'system:cadetship-stanza' });
      doc.status = 'under_review';
      inReview = true;
      summary.transitionedToReview += 1;
      await writeGovernanceAuditOrThrow({
        actorUid: 'system:cadetship-stanza',
        action: 'cadetship.under_review',
        subjectType: 'cadetship',
        subjectId: doc.id,
        details: { personUid: doc.personUid, cohortId: doc.cohortId },
      });
      await notifyReviewDue(db, doc, false);
    } else if (
      doc.status === 'extended' &&
      !doc.reviewDue &&
      doc.extendedTo &&
      now.getTime() >= doc.extendedTo.getTime()
    ) {
      await ref.update({ reviewDue: true, updatedAt: stamp, updatedBy: 'system:cadetship-stanza' });
      doc.reviewDue = true;
      inReview = true;
      summary.reviewDueSet += 1;
      await writeGovernanceAuditOrThrow({
        actorUid: 'system:cadetship-stanza',
        action: 'cadetship.review_due',
        subjectType: 'cadetship',
        subjectId: doc.id,
        details: { personUid: doc.personUid, cohortId: doc.cohortId, round: 2 },
      });
      await notifyReviewDue(db, doc, false);
    } else if (doc.status === 'extended' && doc.reviewDue) {
      inReview = true;
    }

    // 3. The single +7d evaluation reminder.
    if (inReview && !doc.evaluationReminderSentAt) {
      const reviewStart = doc.status === 'extended' ? doc.extendedTo : doc.probationEnd;
      if (reviewStart && now.getTime() >= reviewStart.getTime() + 7 * DAY_MS) {
        const evalSnap = await ref.collection('evaluations').get();
        if (evalSnap.size < 2) {
          await ref.update({
            evaluationReminderSentAt: now,
            updatedAt: stamp,
            updatedBy: 'system:cadetship-stanza',
          });
          summary.remindersSent += 1;
          await notifyReviewDue(db, doc, true);
        }
      }
    }
  }

  return summary;
}
