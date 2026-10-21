/**
 * GET /api/appointments/[instrumentId]/letter-pdf (spec G.5.1).
 *
 * The credential-PDF pattern: renders from the frozen letter.snapshot
 * only. Appointee, officer gate, or Founder may download. Refused and
 * superseded letters still download, with a cover banner line stating
 * the state: the PDF of record shows its own status.
 */

import { NextRequest, NextResponse } from 'next/server';
import { letterDataFromSnapshot } from '@/lib/appointment-letter-adapter';
import { renderAppointmentLetterPDF } from '@/lib/appointment-letter-pdf';
import {
  baseUrlFromRequest,
  canAccessInstrument,
  getInstrument,
  refusalDateLine,
  requireAuthenticated,
  verificationUrlFor,
} from '../../shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> },
) {
  const gate = await requireAuthenticated(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;
  const { instrumentId } = await params;

  const instrument = await getInstrument(db, instrumentId);
  if (!instrument) {
    return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
  }
  if (!(await canAccessInstrument(db, uid, instrument))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!instrument.letter) {
    return NextResponse.json(
      { error_code: 'letter_not_issued', reason: 'No letter has been issued for this instrument.' },
      { status: 409 },
    );
  }

  let statusLine: string | null = instrument.letter.snapshot.statusLine ?? null;
  if (instrument.letter.status === 'superseded') {
    statusLine = 'This letter has been superseded by a corrected letter.';
  } else if (instrument.ratificationState === 'refused') {
    const date = await refusalDateLine(db, instrument);
    statusLine = date
      ? `Appointment refused ratification on ${date}; acts before that date remain valid.`
      : 'Appointment refused ratification; acts before the refusal remain valid.';
  }

  const verificationUrl = verificationUrlFor(
    instrument.letter.verificationCode,
    baseUrlFromRequest(request),
  );
  const data = letterDataFromSnapshot(
    { ...instrument.letter.snapshot, statusLine },
    verificationUrl,
    instrument.letter.contentHash,
  );
  const pdf = await renderAppointmentLetterPDF(data);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="seds-appointment-${instrument.letter.verificationCode}.pdf"`,
      'Content-Length': String(pdf.length),
    },
  });
}
