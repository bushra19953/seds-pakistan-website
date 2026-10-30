import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import {
  checkCapsAndDuplicates,
  emptyIndex,
  publicBracketStatus,
  validateRegistration,
  type RegistrationIndex,
} from '@/lib/grand-prix/registration';

/**
 * South Asia Cloud Aerospace Grand Prix 2026: common registration intake.
 * Task SEDS-TASK-BILAT-PORTAL-6.10 (Deploy & Test Dual-Nation Registration
 * Portal). Public, account free intake: the bilateral squads are external
 * students in Pakistan and Sri Lanka, and identity is carried by the
 * institutional verification IDs the brief requires us to collect, not by
 * a SEDS account. Every registration lands as status "under_review"; a
 * squad only counts as verified after admin review.
 *
 * Storage:
 * - grandPrixRegistrations/{id}: one document per squad.
 * - grandPrixMeta/registrationIndex: a single index document with the
 *   bracket counters and duplicate lookup keys, so a submission costs one
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
    byNation: {
      PK: typeof data.byNation?.PK === 'number' ? data.byNation.PK : base.byNation.PK,
      LK: typeof data.byNation?.LK === 'number' ? data.byNation.LK : base.byNation.LK,
    },
    byTrack: {
      rocketry: typeof data.byTrack?.rocketry === 'number' ? data.byTrack.rocketry : 0,
      robotics: typeof data.byTrack?.robotics === 'number' ? data.byTrack.robotics : 0,
      flatsat: typeof data.byTrack?.flatsat === 'number' ? data.byTrack.flatsat : 0,
    },
    leadEmails: Array.isArray(data.leadEmails) ? data.leadEmails : [],
    squadNameKeys: Array.isArray(data.squadNameKeys) ? data.squadNameKeys : [],
    studentIdKeys: Array.isArray(data.studentIdKeys) ? data.studentIdKeys : [],
  };
}

/** Public bracket status: counts and caps only, never squad identities. */
export async function GET() {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }
    const snap = await db.collection(META_COLLECTION).doc(INDEX_DOC).get();
    const status = publicBracketStatus(toIndex(snap.data()), Date.now());
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
    const squadRef = db.collection(REGISTRATIONS_COLLECTION).doc();

    const outcome = await db.runTransaction(async (tx) => {
      const metaSnap = await tx.get(metaRef);
      const capCheck = checkCapsAndDuplicates(toIndex(metaSnap.data()), reg, Date.now());
      if (!capCheck.ok) return capCheck;

      tx.set(squadRef, {
        squadName: reg.squadName,
        nation: reg.nation,
        track: reg.track,
        institutionName: reg.institutionName,
        institutionId: reg.institutionId,
        city: reg.city,
        members: reg.members,
        leadEmail: reg.leadEmail,
        memberCount: reg.members.length,
        status: 'under_review',
        source: 'grand-prix-portal',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(metaRef, { ...capCheck.nextIndex, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true as const };
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }

    return NextResponse.json(
      {
        ok: true,
        registrationId: squadRef.id,
        status: 'under_review',
        message:
          'Squad registered. Your seat is held while the registration is verified. Keep your registration ID for all correspondence.',
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[grand-prix/registrations] POST failed:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
