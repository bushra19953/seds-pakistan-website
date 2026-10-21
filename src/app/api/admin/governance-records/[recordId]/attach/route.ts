import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { getDriveFileMetadata, getDriveFileStream } from '@/lib/drive/client';
import { UPLOAD_KINDS, getFolderId } from '@/lib/drive/folders';
import { writeGovernanceAudit } from '@/lib/governance/audit';
import {
  RedactionBlockError,
  assertPublishable,
} from '@/lib/governance/redaction-guard';
import { getRegistrationStatus } from '@/lib/governance/registration-status';
import {
  GOVERNANCE_COLLECTION,
  loadRecord,
  toGovernanceRecord,
} from '@/lib/governance/record-io';
import {
  dbUnavailable,
  requireGovernancePermission,
} from '@/lib/governance/route-auth';
import type {
  AccessLevel,
  GovernanceSeries,
  RedactionStatus,
} from '@/lib/governance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST: attach an already-uploaded Drive file (kind 'governance') to a
// record (spec 4.2). The sha256 is computed SERVER-SIDE by streaming the
// file; a file is never replaced - a corrected file is a new version.
export async function POST(
  request: NextRequest,
  { params }: { params: { recordId: string } },
) {
  const db = getDb();
  if (!db) return dbUnavailable();
  const gate = await requireGovernancePermission(request, db as never, [
    'canManageGovernanceRecords',
  ]);
  if (!gate.ok) return gate.response;

  const raw = await loadRecord(db as never, params.recordId);
  if (!raw) {
    return NextResponse.json({ error: 'Record not found' }, { status: 404 });
  }
  if (raw.driveFileId) {
    return NextResponse.json(
      {
        error:
          'This record already has a file. A file is never replaced; upload a new version instead.',
        code: 'already-attached',
      },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const driveFileId =
    typeof body?.driveFileId === 'string' ? body.driveFileId : '';
  if (!driveFileId) {
    return NextResponse.json(
      { error: 'driveFileId is required' },
      { status: 400 },
    );
  }

  let metadata;
  try {
    metadata = await getDriveFileMetadata(driveFileId);
  } catch (e) {
    console.error('[governance attach] metadata failed:', e);
    return NextResponse.json(
      { error: 'Could not read the uploaded file from Drive', code: 'drive-error' },
      { status: 502 },
    );
  }

  const folderId = await getFolderId('governance');
  if (!metadata.parents.includes(folderId)) {
    return NextResponse.json(
      {
        error: 'The file did not land in the governance Drive folder',
        code: 'drive-error',
      },
      { status: 403 },
    );
  }

  const kind = UPLOAD_KINDS.governance;
  const allowedMimes = new Set(Object.values(kind.mimeByExt));
  if (!allowedMimes.has(metadata.mimeType)) {
    return NextResponse.json(
      { error: `File type ${metadata.mimeType} is not allowed for governance records` },
      { status: 400 },
    );
  }
  if (metadata.sizeBytes > kind.maxBytes) {
    return NextResponse.json(
      { error: 'File exceeds the governance size limit' },
      { status: 400 },
    );
  }

  // Stream the file through sha256 without buffering it in memory.
  let sha256: string;
  try {
    const stream = await getDriveFileStream(driveFileId);
    const hash = createHash('sha256');
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      hash.update(chunk as Buffer);
    }
    sha256 = hash.digest('hex');
  } catch (e) {
    console.error('[governance attach] hash failed:', e);
    return NextResponse.json(
      { error: 'Could not read the file bytes from Drive', code: 'drive-error' },
      { status: 502 },
    );
  }

  // Re-run the redaction guard for an already-public record (spec 4.2
  // step 6): attaching must never complete an unpublishable shape.
  if (raw.accessLevel === 'public') {
    try {
      assertPublishable({
        series: raw.series as GovernanceSeries,
        accessLevel: raw.accessLevel as AccessLevel,
        redactionStatus: raw.redactionStatus as RedactionStatus,
      });
    } catch (e) {
      if (e instanceof RedactionBlockError) {
        return NextResponse.json(
          { error: e.message, code: e.code, rule: e.rule },
          { status: 422 },
        );
      }
      throw e;
    }
  }

  const updates: Record<string, unknown> = {
    driveFileId,
    driveUrl: metadata.webViewLink,
    driveFolderId: folderId,
    fileName: metadata.name,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    sha256,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db
    .collection(GOVERNANCE_COLLECTION)
    .doc(params.recordId)
    .update(updates);

  await writeGovernanceAudit(
    'GOVERNANCE_RECORD_FILE_ATTACHED',
    gate.auth.uid,
    params.recordId,
    { driveFileId, sha256 },
  );

  const registrationStatus = await getRegistrationStatus(db as never);
  const record = toGovernanceRecord(
    { ...raw, ...updates, updatedAt: new Date().toISOString() },
    registrationStatus,
  );
  return NextResponse.json({ record: { ...record, hasFile: true } });
}
