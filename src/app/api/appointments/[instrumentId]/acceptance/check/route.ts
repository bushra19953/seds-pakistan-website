/**
 * POST /api/appointments/[instrumentId]/acceptance/check (spec G.4.2
 * step 4, G.5.1). Officer check of a submitted acceptance: 'accepted'
 * files it; 'rejected' requires a note stating what is wrong, which
 * the appointee sees verbatim.
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import {
  INSTRUMENTS_COLLECTION,
  getInstrument,
  notify,
  requireAppointmentsAdmin,
  writeAppointmentAudit,
} from '../../../shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> },
) {
  const gate = await requireAppointmentsAdmin(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;
  const { instrumentId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error_code: 'invalid_json', reason: 'Request body must be JSON.' }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== 'accepted' && decision !== 'rejected') {
    return NextResponse.json(
      { error_code: 'validation_failed', reason: "decision must be 'accepted' or 'rejected'." },
      { status: 400 },
    );
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (decision === 'rejected' && !note) {
    return NextResponse.json(
      { error_code: 'note_required', reason: 'A rejection requires a note stating what is wrong (illegible, unsigned, wrong letter code).' },
      { status: 400 },
    );
  }

  const instrument = await getInstrument(db, instrumentId);
  if (!instrument) {
    return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
  }
  if (instrument.acceptance?.status !== 'submitted') {
    return NextResponse.json(
      { error_code: 'acceptance_not_submitted', reason: 'Only a submitted acceptance can be checked.' },
      { status: 409 },
    );
  }

  const now = admin.firestore.Timestamp.fromMillis(Date.now());
  const acceptance = {
    ...instrument.acceptance,
    status: decision,
    checkedByUid: uid,
    checkedAt: now,
    checkNote: note || null,
  };
  const batch = db.batch();
  batch.update(db.collection(INSTRUMENTS_COLLECTION).doc(instrumentId), {
    acceptance,
    updatedAt: now,
  });
  await writeAppointmentAudit(
    db,
    {
      action: 'appointment_acceptance_checked',
      actorUid: uid,
      targetUidOrResource: instrumentId,
      payload: { decision, note: note || null },
    },
    batch,
  );
  await batch.commit();

  notify(instrument.appointeeUid, {
    type: 'appointment_acceptance_checked',
    title:
      decision === 'accepted'
        ? 'Your signed acceptance has been filed'
        : 'Your signed acceptance needs attention',
    body:
      decision === 'accepted'
        ? `Your signed acceptance for ${instrument.roleDisplayName} was checked and filed.`
        : `Your signed acceptance for ${instrument.roleDisplayName} was rejected: ${note}`,
    link: '/profile/hub',
  });

  return NextResponse.json({
    acceptance: { ...acceptance, checkedAt: now.toDate().toISOString() },
  });
}
