/**
 * POST /api/cadetships/[id]/attest (phase2_spec.md Section F.4).
 *
 * Officer attestation is the evidence model for checklist items 1 and 2:
 *   { item: 'orientation' }            -> items.orientation (attester + time)
 *   { item: 'workshop', eventRef? }    -> appends one workshop attestation,
 *                                         hard-capped at 2 (the checklist
 *                                         requirement); a third is a 409.
 * Callers: a chapter officer of the cadetship's chapter, or the NMD.
 * A cadet can NEVER attest their own items here.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/cadetship/http';
import { dbOrThrow, getCallerRole, canAttest, loadCadetshipDoc } from '@/lib/server/cadetship/access';
import { cadetshipFromFirestore } from '@/lib/server/cadetship/serialize';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { CADETSHIP_LIVE_STATUSES } from '@/lib/cadetship/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUid(req);
    const { id } = await params;
    const db = dbOrThrow();

    const loaded = await loadCadetshipDoc(db, id);
    if (!loaded) return errorJson(404, 'CADETSHIP_NOT_FOUND');
    const cadetship = cadetshipFromFirestore(id, loaded.raw);

    const caller = await getCallerRole(db, uid);
    if (!canAttest(caller, cadetship)) return errorJson(403, 'FORBIDDEN');
    if (!CADETSHIP_LIVE_STATUSES.includes(cadetship.status)) return errorJson(409, 'CADETSHIP_NOT_LIVE');

    const body = (await req.json().catch(() => ({}))) as { item?: string; eventRef?: string };
    const now = new Date();

    if (body.item === 'orientation') {
      if (cadetship.items.orientation.done) {
        return NextResponse.json({ ok: true, alreadyAttested: true, items: cadetship.items });
      }
      const items = {
        ...cadetship.items,
        orientation: { done: true, attestedBy: uid, attestedAt: now },
      };
      await loaded.ref.update({
        items,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: uid,
      });
      await writeGovernanceAuditOrThrow({
        actorUid: uid,
        action: 'cadetship.attest_orientation',
        subjectType: 'cadetship',
        subjectId: id,
        details: { personUid: cadetship.personUid },
      });
      return NextResponse.json({ ok: true, items });
    }

    if (body.item === 'workshop') {
      if (cadetship.items.workshops.count >= 2) {
        return errorJson(409, 'WORKSHOPS_COMPLETE');
      }
      const workshops = {
        count: cadetship.items.workshops.count + 1,
        attestations: [
          ...cadetship.items.workshops.attestations,
          {
            attestedBy: uid,
            attestedAt: now,
            eventRef: typeof body.eventRef === 'string' ? body.eventRef : null,
          },
        ],
      };
      const items = { ...cadetship.items, workshops };
      await loaded.ref.update({
        items,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: uid,
      });
      await writeGovernanceAuditOrThrow({
        actorUid: uid,
        action: 'cadetship.attest_workshop',
        subjectType: 'cadetship',
        subjectId: id,
        details: { personUid: cadetship.personUid, count: workshops.count, eventRef: workshops.attestations[workshops.attestations.length - 1].eventRef },
      });
      return NextResponse.json({ ok: true, items });
    }

    return errorJson(400, 'UNKNOWN_ITEM');
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[cadetships/attest] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
