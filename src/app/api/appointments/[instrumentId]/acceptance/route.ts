/**
 * POST /api/appointments/[instrumentId]/acceptance (spec G.4.2/G.5.1).
 *
 * The appointee ONLY uploads their own signed acceptance. The body
 * carries Drive upload meta + the letter's verification code (which
 * binds the acceptance to THIS letter). The file hash is computed
 * server-side from the Drive file bytes; any fileHash in the body is
 * ignored by design.
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import { computeDriveFileHash } from '@/lib/appointments/acceptance-hash';
import {
  INSTRUMENTS_COLLECTION,
  getInstrument,
  notify,
  requireAuthenticated,
  writeAppointmentAudit,
} from '../../shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instrumentId: string }> },
) {
  const gate = await requireAuthenticated(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;
  const { instrumentId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error_code: 'invalid_json', reason: 'Request body must be JSON.' }, { status: 400 });
  }

  const instrument = await getInstrument(db, instrumentId);
  if (!instrument) {
    return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
  }
  // Only the appointee accepts their own appointment (G.4.2). An admin
  // cannot upload on their behalf.
  if (instrument.appointeeUid !== uid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!instrument.letter || instrument.letter.status !== 'issued') {
    return NextResponse.json(
      { error_code: 'letter_not_current', reason: 'The letter is not in an issued state; a superseded letter cannot be accepted.' },
      { status: 409 },
    );
  }
  const driveFileId = typeof body.driveFileId === 'string' ? body.driveFileId : '';
  if (!driveFileId) {
    return NextResponse.json(
      { error_code: 'validation_failed', reason: 'driveFileId is required (upload the signed letter to Drive first).' },
      { status: 400 },
    );
  }
  const codeSeen = typeof body.verificationCode === 'string' ? body.verificationCode : '';
  if (codeSeen !== instrument.letter.verificationCode) {
    return NextResponse.json(
      { error_code: 'verification_code_mismatch', reason: 'The verification code does not match this letter.' },
      { status: 400 },
    );
  }
  // Re-upload after rejection is allowed and returns to 'submitted';
  // an already-accepted acceptance is final.
  if (instrument.acceptance?.status === 'accepted') {
    return NextResponse.json(
      { error_code: 'acceptance_already_filed', reason: 'This acceptance has already been checked and filed.' },
      { status: 409 },
    );
  }

  let fileHash: string;
  try {
    fileHash = await computeDriveFileHash(driveFileId);
  } catch (err) {
    console.error('[appointments] could not read Drive file for hashing:', err);
    return NextResponse.json(
      { error_code: 'drive_read_failed', reason: 'The uploaded file could not be read back for hashing.' },
      { status: 502 },
    );
  }

  const now = admin.firestore.Timestamp.fromMillis(Date.now());
  const acceptance = {
    status: 'submitted',
    driveFileId,
    driveWebViewLink:
      typeof body.driveWebViewLink === 'string' ? body.driveWebViewLink : null,
    fileName: typeof body.fileName === 'string' ? body.fileName : null,
    sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : null,
    contentType: typeof body.contentType === 'string' ? body.contentType : null,
    fileHash,
    uploadedAt: now,
    uploadedByUid: uid,
    letterVerificationCodeSeen: codeSeen,
  };
  const ref = db.collection(INSTRUMENTS_COLLECTION).doc(instrumentId);
  const batch = db.batch();
  batch.update(ref, { acceptance, updatedAt: now });
  await writeAppointmentAudit(
    db,
    {
      action: 'appointment_acceptance_submitted',
      actorUid: uid,
      targetUidOrResource: instrumentId,
      payload: { fileHash, driveFileId },
    },
    batch,
  );
  await batch.commit();

  // Notify the appointing authority is not needed here; officers check
  // the queue. The audit + queue surface is the record (notification to
  // the issuer when they differ from the appointee is skipped by
  // design: G.4.2 step 3 notifies GS / canManagePositions holders, who
  // are reached through the admin queue in v1.)
  notify(uid, {
    type: 'appointment_acceptance_submitted',
    title: 'Signed acceptance submitted',
    body: `Your signed acceptance for ${instrument.roleDisplayName} is awaiting an officer check.`,
    link: '/profile/hub',
  });

  return NextResponse.json({ acceptance: { ...acceptance, uploadedAt: now.toDate().toISOString() } });
}
