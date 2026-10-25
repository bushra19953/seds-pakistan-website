/**
 * Cadetship creation + cohort allocation (phase2_spec.md Sections F.1, F.2,
 * F.6). Two entry points sharing one core builder:
 *
 * - allocateCohortAndCreateCadetship(): the canonical TRANSACTION version.
 *   Cohort allocation is transactional on cohort_counters/{fyEndYear}, so
 *   two simultaneous first approvals of an FY land in the SAME cohort,
 *   never two cohort-1 docs.
 *
 * - queueCadetshipEnrolmentInBatch(): the version the universal-review
 *   route uses, because that route commits the approval through a
 *   WriteBatch and F.6 requires the cadetship create to JOIN the approval
 *   batch (an approval that succeeds while enrolment fails is the
 *   split-brain F exists to prevent; if queueing throws, the route aborts
 *   before batch.commit() and the approval fails). Cohort/cadetCount
 *   counters use FieldValue.increment inside the batch, which commutes
 *   safely under concurrent approvals; the new-cohort decision is based
 *   on a pre-read, so two racing first approvals both write the SAME
 *   deterministic cohort doc id and both point at cohort-1 - the F.1
 *   outcome - while counters may over-count lastSequence by the number of
 *   racers (reconciled when the next cohort opens, which reads the
 *   cohorts collection, not the counter, for its sequence base in the
 *   transaction version).
 *
 * startedAt note: F.1 defines startedAt as the server timestamp of the
 * approval transaction. In the batch path the reviewedAt sentinel cannot
 * be read back before commit, so startedAt is the server clock at request
 * handling - the same instant for every practical purpose; probationEnd is
 * computed from it by the single clock helper.
 */

import admin from 'firebase-admin';
import { probationWindow, fiscalYearOf, cohortIdFor } from './clock';
import {
  emptyCadetshipItems,
  initialDecision,
  initialDuesGate,
  CADETSHIP_LIVE_STATUSES,
} from '@/lib/cadetship/types';

export interface CreateCadetshipInput {
  personUid: string;
  applicationId: string;
  chapterId: string;
  createdVia: 'application_approval' | 'shortlist_redirect';
  /** Server time of the approval (see startedAt note above). */
  startedAt: Date;
  openedBy: string;
}

export interface CreateCadetshipResult {
  cadetshipId: string;
  cohortId: string;
  created: boolean;
  /**
   * The exact cadetship doc body queued / written for a NEW enrolment
   * (created: true only; undefined otherwise). The batch variant's
   * caller owns batch.commit(), so it needs the body to issue the
   * post-commit Supabase mirror (mirrorCadetshipSet) once the commit
   * lands - mirroring at queue time would precede the Firestore commit.
   */
  cadetshipData?: ReturnType<typeof cadetshipDocData>;
}

type Firestore = admin.firestore.Firestore;

function cadetshipDocData(input: CreateCadetshipInput, cohortId: string) {
  const { probationEnd } = probationWindow(input.startedAt);
  const ts = admin.firestore.Timestamp.fromDate;
  return {
    personUid: input.personUid,
    applicationId: input.applicationId,
    cohortId,
    chapterId: input.chapterId,
    createdVia: input.createdVia,
    status: 'active',
    startedAt: ts(input.startedAt),
    probationEnd: ts(probationEnd),
    extendedTo: null,
    extensionUsed: false,
    reviewDue: false,
    items: emptyCadetshipItems(),
    conduct: { acknowledged: false, acknowledgedAt: null },
    duesGate: initialDuesGate(),
    decision: initialDecision(1),
    membershipClassWritePending: false,
    evaluationReminderSentAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: input.openedBy,
  };
}

function cohortDocData(fyLabel: string, fyEndYear: number, sequence: number, openedBy: string) {
  return {
    fyLabel,
    fyEndYear,
    sequence,
    openedAt: admin.firestore.FieldValue.serverTimestamp(),
    openedBy,
    status: 'open',
    closedAt: null,
    cadetCount: 0,
    notes: null,
  };
}

async function findOpenCohort(
  db: Firestore,
  fyEndYear: number,
): Promise<{ id: string; sequence: number } | null> {
  const snap = await db
    .collection('cohorts')
    .where('fyEndYear', '==', fyEndYear)
    .where('status', '==', 'open')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, sequence: (doc.data().sequence as number) ?? 1 };
}

async function findLiveCadetship(
  db: Firestore,
  personUid: string,
): Promise<{ id: string; cohortId: string } | null> {
  const snap = await db
    .collection('cadetships')
    .where('personUid', '==', personUid)
    .where('status', 'in', CADETSHIP_LIVE_STATUSES)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, cohortId: doc.data().cohortId as string };
}

/**
 * Canonical transaction version. Returns the existing live cadetship
 * (created: false) when one already exists - enrolment is idempotent.
 */
export async function allocateCohortAndCreateCadetship(
  db: Firestore,
  input: CreateCadetshipInput,
): Promise<CreateCadetshipResult> {
  const fy = fiscalYearOf(input.startedAt); // cadetship convention: Jul-Jun
  return db.runTransaction(async (tx) => {
    const liveQuery = db
      .collection('cadetships')
      .where('personUid', '==', input.personUid)
      .where('status', 'in', CADETSHIP_LIVE_STATUSES)
      .limit(1);
    const liveSnap = await tx.get(liveQuery);
    if (!liveSnap.empty) {
      const doc = liveSnap.docs[0];
      return { cadetshipId: doc.id, cohortId: doc.data().cohortId as string, created: false };
    }

    // Supersede any prior exited cadetship for this person.
    const exitedSnap = await tx.get(
      db.collection('cadetships').where('personUid', '==', input.personUid).where('status', '==', 'exited'),
    );
    exitedSnap.forEach((doc) => {
      tx.update(doc.ref, { status: 'superseded', updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: input.openedBy });
    });

    // Cohort allocation on the counters doc.
    const counterRef = db.collection('cohort_counters').doc(String(fy.fyEndYear));
    const counterSnap = await tx.get(counterRef);
    const lastSequence = counterSnap.exists ? ((counterSnap.data()?.lastSequence as number) ?? 0) : 0;

    const openSnap = await tx.get(
      db.collection('cohorts').where('fyEndYear', '==', fy.fyEndYear).where('status', '==', 'open').limit(1),
    );

    let cohortId: string;
    if (!openSnap.empty) {
      cohortId = openSnap.docs[0].id;
      tx.update(openSnap.docs[0].ref, { cadetCount: admin.firestore.FieldValue.increment(1) });
    } else {
      const sequence = lastSequence + 1;
      cohortId = cohortIdFor(fy.fyEndYear, sequence);
      tx.set(counterRef, { lastSequence: sequence }, { merge: true });
      tx.set(db.collection('cohorts').doc(cohortId), {
        ...cohortDocData(fy.fyLabel, fy.fyEndYear, sequence, input.openedBy),
        cadetCount: 1,
      });
    }

    const cadetRef = db.collection('cadetships').doc();
    tx.set(cadetRef, cadetshipDocData(input, cohortId));
    return { cadetshipId: cadetRef.id, cohortId, created: true };
  });
}

/**
 * Batch version for the universal-review approval path (see header note).
 * Performs its reads up front, then queues every write into `batch`.
 * Throws on read failure so the caller aborts the approval (F.6).
 * On a new enrolment the queued cadetship body is returned as
 * `cadetshipData` so the caller can mirror it to Supabase AFTER its
 * batch.commit() succeeds (this function must not mirror itself: the
 * commit has not happened yet, and may never happen).
 */
export async function queueCadetshipEnrolmentInBatch(
  db: Firestore,
  batch: admin.firestore.WriteBatch,
  input: CreateCadetshipInput,
): Promise<CreateCadetshipResult> {
  const fy = fiscalYearOf(input.startedAt);

  const live = await findLiveCadetship(db, input.personUid);
  if (live) return { cadetshipId: live.id, cohortId: live.cohortId, created: false };

  const exitedSnap = await db
    .collection('cadetships')
    .where('personUid', '==', input.personUid)
    .where('status', '==', 'exited')
    .get();
  exitedSnap.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'superseded',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: input.openedBy,
    });
  });

  const open = await findOpenCohort(db, fy.fyEndYear);
  let cohortId: string;
  if (open) {
    cohortId = open.id;
    batch.update(db.collection('cohorts').doc(cohortId), {
      cadetCount: admin.firestore.FieldValue.increment(1),
    });
  } else {
    const counterSnap = await db.collection('cohort_counters').doc(String(fy.fyEndYear)).get();
    const lastSequence = counterSnap.exists ? ((counterSnap.data()?.lastSequence as number) ?? 0) : 0;
    const sequence = lastSequence + 1;
    cohortId = cohortIdFor(fy.fyEndYear, sequence);
    batch.set(db.collection('cohort_counters').doc(String(fy.fyEndYear)), { lastSequence: sequence }, { merge: true });
    batch.set(db.collection('cohorts').doc(cohortId), {
      ...cohortDocData(fy.fyLabel, fy.fyEndYear, sequence, input.openedBy),
      cadetCount: 1,
    });
  }

  const cadetRef = db.collection('cadetships').doc();
  const cadetshipData = cadetshipDocData(input, cohortId);
  batch.set(cadetRef, cadetshipData);
  return { cadetshipId: cadetRef.id, cohortId, created: true, cadetshipData };
}

/**
 * Legacy-invite path (F.6): an already-invited person whose acceptance must
 * create a record after F ships gets a cadetship through the SAME core,
 * stamped createdVia 'shortlist_redirect' so it stays visible and
 * countable in admin - never silent.
 */
export async function createCadetshipFromLegacyInvite(
  db: Firestore,
  input: Omit<CreateCadetshipInput, 'createdVia'>,
): Promise<CreateCadetshipResult> {
  return allocateCohortAndCreateCadetship(db, { ...input, createdVia: 'shortlist_redirect' });
}
