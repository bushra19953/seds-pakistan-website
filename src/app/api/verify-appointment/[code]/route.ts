/**
 * GET /api/verify-appointment/[code] (Workstream G, spec G.4.3/G.5.1).
 *
 * Public, unauthenticated. Returns ONLY the sanitised summary:
 * appointee name, role, appointing authority (name + office),
 * effective date, ratification state in plain words, acceptance filed
 * yes/no, letter status, and the content-hash integrity result.
 * No email, no uid, no chapter-internal data, no Drive link or id,
 * no phone. A superseded or refused instrument still resolves (an
 * appointment letter is a historical record; 410 is for revoked
 * certificates, not for this). Unknown code: 404 with the fixed line.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import {
  MisconfiguredError,
  hashPayloadFromSnapshot,
  verifyInstrumentContentHash,
} from '@/lib/appointments/hash';
import {
  INSTRUMENTS_COLLECTION,
  ratificationPlainLine,
  refusalDateLine,
  tsToIso,
} from '../../appointments/shared';
import type { AppointmentInstrument } from '@/types/appointment-instrument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Verification is temporarily unavailable.' },
      { status: 503 },
    );
  }

  const snap = await db
    .collection(INSTRUMENTS_COLLECTION)
    .where('letter.verificationCode', '==', code)
    .limit(1)
    .get();
  if (snap.empty) {
    return NextResponse.json(
      {
        found: false,
        message: 'No appointment letter found for this code.',
      },
      { status: 404 },
    );
  }
  const docSnap = snap.docs[0];
  const instrument = {
    ...((docSnap.data() ?? {}) as unknown as AppointmentInstrument),
    id: docSnap.id,
  };
  if (!instrument.letter) {
    return NextResponse.json(
      {
        found: false,
        message: 'No appointment letter found for this code.',
      },
      { status: 404 },
    );
  }

  // Integrity: recompute from the stored snapshot (G.5.3). A mismatch
  // is reported with the fixed public line, never silently passed.
  let integrity: { status: 'passed' | 'failed' | 'unavailable'; line: string | null };
  try {
    const payload = hashPayloadFromSnapshot(
      instrument.letter.snapshot,
      instrument.appointedByUid,
      instrument.letter.templateVersion,
    );
    const ok = verifyInstrumentContentHash(instrument.letter.contentHash, payload);
    integrity = ok
      ? { status: 'passed', line: 'Record integrity check passed.' }
      : {
          status: 'failed',
          line: 'Record integrity check failed - contact the General Secretary.',
        };
  } catch (err) {
    if (err instanceof MisconfiguredError) {
      integrity = { status: 'unavailable', line: null };
    } else {
      integrity = {
        status: 'failed',
        line: 'Record integrity check failed - contact the General Secretary.',
      };
    }
  }

  const refused = await refusalDateLine(
    db as import('firebase-admin/firestore').Firestore,
    instrument,
  );

  return NextResponse.json({
    found: true,
    instrumentNumber: instrument.letter.snapshot.instrumentNumber,
    appointeeName: instrument.appointeeDisplayName,
    roleDisplayName: instrument.roleDisplayName,
    appointedByName: instrument.appointedByDisplayName,
    appointedByOffice: instrument.appointedByOffice,
    effectiveFrom: tsToIso(instrument.effectiveFrom),
    ratificationState: instrument.ratificationState,
    ratificationLine: ratificationPlainLine(instrument, refused),
    acceptanceFiled: instrument.acceptance?.status === 'accepted',
    letterStatus:
      instrument.letter.status === 'superseded'
        ? 'Superseded by a corrected letter'
        : 'Current',
    integrity,
  });
}
