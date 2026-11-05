import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import {
  checkWindowAndDuplicates,
  emptyIndex,
  publicRegistrationStatus,
  validateRegistration,
  type RegistrationIndex,
} from '@/lib/grand-prix/registration';

/**
 * International Aerospace Masterclass Series 2026: common enrolment intake.
 * Public, account-less intake: the bilateral enrolments are external
 * students in Pakistan and Sri Lanka and industry observers, and identity
 * is carried by the institutional verification IDs the brief requires us
 * to collect, not by a SEDS account. Every enrolment lands as status
 * "under_review"; an enrolment only counts as verified after admin review.
 * No payment is collected here: the pass is selected and its fee displayed
 * only. Collection is a separate later brief.
 *
 * Storage:
 * - grandPrixRegistrations/{id}: one document per individual enrolment.
 * - grandPrixMeta/registrationIndex: a single index document with the
 *   enrolment count and duplicate lookup keys, so a submission costs one
 *   read inside its transaction instead of a collection scan. That matters
 *   on the shared Firestore read quota.
 *
 * All access is through this Admin SDK route; the collections are never
 * read or written by client SDK code.
 */

const REGISTRATIONS_COLLECTION = 'grandPrixRegistrations';
const META_COLLECTION = 'grandPrixMeta';
const INDEX_DOC = 'registrationIndex';

function toIndex(data: FirebaseFirestore.DocumentData | undefined): RegistrationIndex {
  if (!data) return emptyIndex();
  const base = emptyIndex();
  return {
    total: typeof data.total === 'number' ? data.total : 0,
    emails: Array.isArray(data.emails) ? data.emails : base.emails,
    studentIdKeys: Array.isArray(data.studentIdKeys) ? data.studentIdKeys : base.studentIdKeys,
  };
}

/** Public registration status: window state and dates only, never enrollee identities. */
export async function GET() {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }
    const snap = await db.collection(META_COLLECTION).doc(INDEX_DOC).get();
    const status = publicRegistrationStatus(toIndex(snap.data()), Date.now());
    return NextResponse.json({ ok: true, ...status });
  } catch (err) {
    console.error('[grand-prix/registrations] GET failed:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const validation = validateRegistration(body);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.errors[0], errors: validation.errors },
        { status: 400 },
      );
    }
    const reg = validation.value;

    const metaRef = db.collection(META_COLLECTION).doc(INDEX_DOC);
    const enrolmentRef = db.collection(REGISTRATIONS_COLLECTION).doc();

    const outcome = await db.runTransaction(async (tx) => {
      const metaSnap = await tx.get(metaRef);
      const windowCheck = checkWindowAndDuplicates(toIndex(metaSnap.data()), reg, Date.now());
      if (!windowCheck.ok) return windowCheck;

      tx.set(enrolmentRef, {
        fullName: reg.fullName,
        studentId: reg.studentId,
        email: reg.email,
        discipline: reg.discipline,
        whatsapp: reg.whatsapp,
        nation: reg.nation,
        passType: reg.passType,
        institutionName: reg.institutionName,
        institutionId: reg.institutionId,
        city: reg.city,
        leadEmail: reg.leadEmail,
        studentIdKey: reg.studentIdKey,
        status: 'under_review',
        source: 'grand-prix-portal',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(metaRef, { ...windowCheck.nextIndex, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true as const };
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }

    return NextResponse.json(
      {
        ok: true,
        registrationId: enrolmentRef.id,
        status: 'under_review',
        message:
          'Enrolment received. Your place is held while the enrolment is verified. Keep your registration ID for all correspondence.',
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[grand-prix/registrations] POST failed:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
