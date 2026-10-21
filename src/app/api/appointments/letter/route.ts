/**
 * POST /api/appointments/letter (Workstream G, spec G.5.1/G.4.1).
 *
 * Body: { roleHistoryId, preview?: boolean }
 * - preview true: renders the letter PDF from the snapshot-to-be and
 *   returns it WITHOUT persisting anything (the human check on the
 *   real appointing name + office before anything is of record).
 * - otherwise: issues idempotently. An existing non-superseded
 *   instrument for the register record returns 200 as-is; a fresh
 *   issue writes the instrument + audit in one batch, files the PDF
 *   to Drive (failure never un-issues), and notifies the appointee.
 */

import { NextRequest, NextResponse } from 'next/server';
import { MisconfiguredError } from '@/lib/appointments/hash';
import { fileLetterPdfToDrive } from '@/lib/appointments/drive-filing';
import { letterDataFromSnapshot } from '@/lib/appointment-letter-adapter';
import { renderAppointmentLetterPDF } from '@/lib/appointment-letter-pdf';
import {
  INSTRUMENTS_COLLECTION,
  baseUrlFromRequest,
  buildInstrumentDoc,
  findInstrumentsByRoleHistoryId,
  loadIssueContext,
  notify,
  requireAppointmentsAdmin,
  serializeInstrument,
  verificationUrlFor,
  writeAppointmentAudit,
} from '../shared';
import type { AppointmentInstrument } from '@/types/appointment-instrument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const gate = await requireAppointmentsAdmin(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error_code: 'invalid_json', reason: 'Request body must be JSON.' }, { status: 400 });
  }
  const roleHistoryId =
    typeof body.roleHistoryId === 'string' ? body.roleHistoryId : '';
  if (!roleHistoryId) {
    return NextResponse.json(
      { error_code: 'validation_failed', reason: 'roleHistoryId is required.' },
      { status: 400 },
    );
  }
  const preview = body.preview === true;

  const ctx = await loadIssueContext(db, roleHistoryId);
  if (!ctx.ok) {
    return NextResponse.json(ctx.blocked.body, { status: ctx.blocked.status });
  }

  // Idempotency: a live (non-superseded) instrument already exists.
  if (!preview) {
    const existing = await findInstrumentsByRoleHistoryId(db, roleHistoryId);
    const live = existing.find(
      (i) => i.letter && i.letter.status === 'issued',
    );
    if (live) {
      return NextResponse.json(
        { instrument: serializeInstrument(live), idempotent: true },
        { status: 200 },
      );
    }
  }

  let built: Awaited<ReturnType<typeof buildInstrumentDoc>>;
  try {
    built = await buildInstrumentDoc(db, uid, ctx);
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      return NextResponse.json(
        { error_code: 'misconfigured', reason: err.message },
        { status: 500 },
      );
    }
    throw err;
  }

  const baseUrl = baseUrlFromRequest(request);
  const verificationUrl = verificationUrlFor(built.verificationCode, baseUrl);
  const instrumentData = built.data as unknown as AppointmentInstrument & {
    letter: NonNullable<AppointmentInstrument['letter']>;
  };
  const letterData = letterDataFromSnapshot(
    instrumentData.letter.snapshot,
    verificationUrl,
    built.contentHash,
  );

  if (preview) {
    const pdf = await renderAppointmentLetterPDF(letterData);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="seds-appointment-preview-${built.verificationCode}.pdf"`,
        'Content-Length': String(pdf.length),
      },
    });
  }

  // Issue: instrument + audit in one batch (repo pattern; the
  // roleHistoryId pre-check above is the uniqueness guard).
  const batch = db.batch();
  batch.set(db.collection(INSTRUMENTS_COLLECTION).doc(built.instrumentId), built.data);
  await writeAppointmentAudit(
    db,
    {
      action: 'appointment_letter_issued',
      actorUid: uid,
      targetUidOrResource: built.instrumentId,
      payload: {
        roleHistoryId,
        verificationCode: built.verificationCode,
        roleKey: ctx.record.roleKey,
      },
    },
    batch,
  );
  await batch.commit();

  // File the PDF of record to Drive; failure keeps the letter issued.
  let filing: 'filed' | 'failed' = 'failed';
  try {
    const pdf = await renderAppointmentLetterPDF(letterData);
    const filed = await fileLetterPdfToDrive(
      `seds-appointment-${built.verificationCode}.pdf`,
      pdf,
    );
    const current = built.data.letter as Record<string, unknown>;
    await db
      .collection(INSTRUMENTS_COLLECTION)
      .doc(built.instrumentId)
      .update({
        letter: {
          ...current,
          driveFileId: filed.driveFileId,
          driveWebViewLink: filed.driveWebViewLink,
          fileName: `seds-appointment-${built.verificationCode}.pdf`,
          sizeBytes: filed.sizeBytes,
        },
        updatedAt: built.data.updatedAt,
      });
    filing = 'filed';
  } catch (err) {
    console.error('[appointments] Drive filing failed for', built.instrumentId, err);
  }

  const saved = await db
    .collection(INSTRUMENTS_COLLECTION)
    .doc(built.instrumentId)
    .get();
  const savedInstrument = {
    ...((saved.data() ?? {}) as unknown as AppointmentInstrument),
    id: built.instrumentId,
  };

  notify(ctx.record.appointeeUid, {
    type: 'appointment_letter_issued',
    title: `Your appointment letter for ${ctx.taxonomy.displayName} is ready`,
    body: 'Your appointment letter has been issued. Open your profile to read it and upload your signed acceptance.',
    link: '/profile/hub',
  });
  if (ctx.record.appointedByUid && ctx.record.appointedByUid !== uid) {
    notify(ctx.record.appointedByUid, {
      type: 'appointment_letter_issued',
      title: `Appointment letter issued for ${ctx.taxonomy.displayName}`,
      body: `An appointment letter naming you as appointing authority was issued to ${ctx.appointeeDisplayName}.`,
      link: '/admin/positions',
    });
  }

  return NextResponse.json(
    { instrument: serializeInstrument(savedInstrument), filing },
    { status: 201 },
  );
}
