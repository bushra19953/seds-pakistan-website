/**
 * POST /api/appointments/[instrumentId]/reissue (spec G.4.1 step 9).
 *
 * A wrong name, date, or citation on an issued letter is fixed by
 * SUPERSEDING, never by editing: a new instrument is built from the
 * (corrected) register record with a fresh verification code, the old
 * instrument is marked superseded with both link fields set, and the
 * appointee is notified. Acceptance filed against the old code does
 * not carry over.
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import { MisconfiguredError } from '@/lib/appointments/hash';
import { fileLetterPdfToDrive } from '@/lib/appointments/drive-filing';
import { letterDataFromSnapshot } from '@/lib/appointment-letter-adapter';
import { renderAppointmentLetterPDF } from '@/lib/appointment-letter-pdf';
import {
  INSTRUMENTS_COLLECTION,
  baseUrlFromRequest,
  buildInstrumentDoc,
  getInstrument,
  loadIssueContext,
  notify,
  requireAppointmentsAdmin,
  serializeInstrument,
  verificationUrlFor,
  writeAppointmentAudit,
} from '../../shared';
import type { AppointmentInstrument } from '@/types/appointment-instrument';

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

  const old = await getInstrument(db, instrumentId);
  if (!old) {
    return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
  }
  if (!old.letter) {
    return NextResponse.json(
      { error_code: 'letter_not_issued', reason: 'Only an issued letter can be reissued.' },
      { status: 409 },
    );
  }
  if (old.letter.status === 'superseded') {
    return NextResponse.json(
      { error_code: 'already_superseded', reason: 'This letter is already superseded; reissue from the current instrument.' },
      { status: 409 },
    );
  }

  // Rebuild from the register record as it stands NOW (the correction
  // lives in the register; the new letter freezes the corrected data).
  const ctx = await loadIssueContext(db, old.roleHistoryId);
  if (!ctx.ok) {
    return NextResponse.json(ctx.blocked.body, { status: ctx.blocked.status });
  }

  let built: Awaited<ReturnType<typeof buildInstrumentDoc>>;
  try {
    built = await buildInstrumentDoc(db, uid, ctx, {
      supersedesInstrumentId: instrumentId,
    });
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      return NextResponse.json(
        { error_code: 'misconfigured', reason: err.message },
        { status: 500 },
      );
    }
    throw err;
  }

  const now = admin.firestore.Timestamp.fromMillis(Date.now());
  const batch = db.batch();
  batch.set(db.collection(INSTRUMENTS_COLLECTION).doc(built.instrumentId), built.data);
  batch.update(db.collection(INSTRUMENTS_COLLECTION).doc(instrumentId), {
    letter: { ...old.letter, status: 'superseded' },
    supersededByInstrumentId: built.instrumentId,
    updatedAt: now,
  });
  await writeAppointmentAudit(
    db,
    {
      action: 'appointment_letter_reissued',
      actorUid: uid,
      targetUidOrResource: built.instrumentId,
      payload: {
        supersedesInstrumentId: instrumentId,
        roleHistoryId: old.roleHistoryId,
        verificationCode: built.verificationCode,
      },
    },
    batch,
  );
  await batch.commit();

  // File the corrected letter; failure never un-issues (same as issue).
  try {
    const newInstrumentData = built.data as unknown as AppointmentInstrument & {
      letter: NonNullable<AppointmentInstrument['letter']>;
    };
    const verificationUrl = verificationUrlFor(
      built.verificationCode,
      baseUrlFromRequest(request),
    );
    const pdf = await renderAppointmentLetterPDF(
      letterDataFromSnapshot(
        newInstrumentData.letter.snapshot,
        verificationUrl,
        built.contentHash,
      ),
    );
    const filed = await fileLetterPdfToDrive(
      `seds-appointment-${built.verificationCode}.pdf`,
      pdf,
    );
    await db
      .collection(INSTRUMENTS_COLLECTION)
      .doc(built.instrumentId)
      .update({
        letter: {
          ...(built.data.letter as Record<string, unknown>),
          driveFileId: filed.driveFileId,
          driveWebViewLink: filed.driveWebViewLink,
          fileName: `seds-appointment-${built.verificationCode}.pdf`,
          sizeBytes: filed.sizeBytes,
        },
        updatedAt: now,
      });
  } catch (err) {
    console.error('[appointments] Drive filing failed for reissue', built.instrumentId, err);
  }

  notify(old.appointeeUid, {
    type: 'appointment_letter_reissued',
    title: 'A corrected appointment letter has been issued',
    body: `Your earlier appointment letter for ${old.roleDisplayName} has been superseded by a corrected letter. Please sign and upload acceptance for the new letter; the earlier acceptance does not carry over.`,
    link: '/profile/hub',
  });

  const saved = await db
    .collection(INSTRUMENTS_COLLECTION)
    .doc(built.instrumentId)
    .get();
  const savedInstrument = {
    ...((saved.data() ?? {}) as unknown as AppointmentInstrument),
    id: built.instrumentId,
  };
  return NextResponse.json(
    { instrument: serializeInstrument(savedInstrument) },
    { status: 201 },
  );
}
