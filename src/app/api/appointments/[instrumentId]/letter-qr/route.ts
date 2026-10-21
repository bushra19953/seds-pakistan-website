/**
 * GET /api/appointments/[instrumentId]/letter-qr (spec G.5.1).
 * The credential-QR pattern cloned: { dataUrl, verificationUrl } with
 * a private cache header; same gate as the letter PDF route.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  baseUrlFromRequest,
  canAccessInstrument,
  getInstrument,
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

  const verificationUrl = verificationUrlFor(
    instrument.letter.verificationCode,
    baseUrlFromRequest(request),
  );
  const QRCode = (await import('qrcode')).default;
  const dataUrl = await QRCode.toDataURL(verificationUrl, {
    margin: 1,
    scale: 6,
  });
  return NextResponse.json(
    { dataUrl, verificationUrl },
    { headers: { 'Cache-Control': 'private, max-age=3600' } },
  );
}
