/**
 * POST /api/cadetships/me/acknowledge-conduct (phase2_spec.md Section F.4).
 *
 * The ONLY cadet self-service write in the cadetship system: the cadet
 * acknowledges the code of conduct on their own live cadetship. No officer
 * can do this for them, and the cadet can write nothing else through it.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/cadetship/http';
import { dbOrThrow } from '@/lib/server/cadetship/access';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { CADETSHIP_LIVE_STATUSES } from '@/lib/cadetship/types';
import {
  isCadetshipsSupaEnabled,
  mirrorCadetshipUpdate,
  tryFindLiveCadetshipForPerson,
} from '@/lib/supa-seams/hr-cadetships';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const db = dbOrThrow();

    // Supa-first lookup of the caller's live cadetship when the
    // surface is ON; adapter error or a disabled flag falls back to
    // the exact Firestore query below. The Firestore doc ref is
    // always the write target (Firestore stays primary).
    let supaDoc: { id: string; conduct?: { acknowledged?: unknown } } | null | undefined;
    if (isCadetshipsSupaEnabled()) {
      const supaResult = await tryFindLiveCadetshipForPerson(uid, CADETSHIP_LIVE_STATUSES);
      if (supaResult.status === 'ok') {
        supaDoc =
          supaResult.value === null
            ? null
            : {
                id: supaResult.value.id,
                conduct: supaResult.value.conduct as { acknowledged?: unknown } | undefined,
              };
      }
    }
    if (supaDoc === null) return errorJson(404, 'NO_LIVE_CADETSHIP');

    const snap = await db
      .collection('cadetships')
      .where('personUid', '==', uid)
      .where('status', 'in', CADETSHIP_LIVE_STATUSES)
      .limit(1)
      .get();
    if (snap.empty) {
      // With the surface ON, the Supa lookup above already decided
      // existence; a Firestore miss here means the mirror is ahead of
      // Firestore, which cannot happen (Firestore writes first) --
      // treat it as not found rather than inventing a write target.
      return errorJson(404, 'NO_LIVE_CADETSHIP');
    }

    const doc = snap.docs[0];
    const data = doc.data() as Record<string, any>;
    const acknowledged =
      supaDoc !== undefined ? supaDoc.conduct?.acknowledged === true : data.conduct?.acknowledged === true;
    if (acknowledged) {
      return NextResponse.json({ ok: true, alreadyAcknowledged: true, cadetshipId: doc.id });
    }

    const now = new Date();
    await doc.ref.update({
      conduct: { acknowledged: true, acknowledgedAt: now },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
    await mirrorCadetshipUpdate(doc.id, {
      conduct: { acknowledged: true, acknowledgedAt: now },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'cadetship.conduct_acknowledged',
      subjectType: 'cadetship',
      subjectId: doc.id,
      details: { personUid: uid },
    });
    return NextResponse.json({ ok: true, cadetshipId: doc.id, acknowledgedAt: now.toISOString() });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[cadetships/acknowledge-conduct] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
