import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { writeGovernanceAudit } from '@/lib/governance/audit';
import { getRegistrationStatus } from '@/lib/governance/registration-status';
import {
  GOVERNANCE_COLLECTION,
  loadFamily,
  loadRecord,
  toGovernanceRecord,
} from '@/lib/governance/record-io';
import {
  dbUnavailable,
  requireGovernancePermission,
} from '@/lib/governance/route-auth';
import { ADOPTION_STATUS, type AdoptionStatus } from '@/lib/governance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUITE_SERIES = ['constitution_suite', 'policy', 'mou'];

// Fields a PATCH may never touch (spec 4.2). redactionStatus and
// consentId change only through the transition route, so their changes
// are audited as governance acts, not metadata edits.
const FORBIDDEN_PATCH_FIELDS = [
  'recordId',
  'familyId',
  'series',
  'version',
  'supersedesRecordId',
  'supersededByRecordId',
  'status',
  'accessLevel',
  'redactionStatus',
  'driveFileId',
  'driveUrl',
  'driveFolderId',
  'fileName',
  'mimeType',
  'sizeBytes',
  'sha256',
  'effectiveStatus',
  'uploadedBy',
  'approvedBy',
  'consentId',
  'createdAt',
  'updatedAt',
] as const;

const EDITABLE_FIELDS = [
  'title',
  'parties',
  'recordDate',
  'layer',
  'notes',
  'links',
  'adoptionStatus',
] as const;

// GET: record detail + the family's version list (spec 4.2).
export async function GET(
  request: NextRequest,
  { params }: { params: { recordId: string } },
) {
  const db = getDb();
  if (!db) return dbUnavailable();
  const gate = await requireGovernancePermission(request, db as never, [
    'canManageGovernanceRecords',
    'canApproveGovernanceRecords',
  ]);
  if (!gate.ok) return gate.response;

  const raw = await loadRecord(db as never, params.recordId);
  if (!raw) {
    return NextResponse.json({ error: 'Record not found' }, { status: 404 });
  }
  const registrationStatus = await getRegistrationStatus(db as never);
  const record = toGovernanceRecord(raw, registrationStatus);
  const family = await loadFamily(db as never, record.familyId);
  const versions = family.map((r) => ({
    recordId: r.recordId as string,
    version: Number(r.version ?? 0),
    status: r.status as string,
    recordDate: r.recordDate as string,
    sha256: (r.sha256 as string | null) ?? null,
  }));
  return NextResponse.json({
    record: { ...record, hasFile: !!record.driveFileId },
    versions,
  });
}

// PATCH: metadata edits only (spec 4.2). Gate: canManageGovernanceRecords.
export async function PATCH(
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
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  for (const field of FORBIDDEN_PATCH_FIELDS) {
    if (field in body) {
      return NextResponse.json(
        { error: `Field '${field}' cannot be edited via PATCH` },
        { status: 400 },
      );
    }
  }

  const updates: Record<string, unknown> = {};
  const changedFields: string[] = [];
  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (field === 'title' && typeof value !== 'string') {
      return NextResponse.json({ error: 'title must be a string' }, { status: 400 });
    }
    if (field === 'parties' && !Array.isArray(value)) {
      return NextResponse.json({ error: 'parties must be an array' }, { status: 400 });
    }
    if (
      field === 'recordDate' &&
      (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    ) {
      return NextResponse.json({ error: 'recordDate must be an ISO date' }, { status: 400 });
    }
    if (field === 'layer') {
      if (!SUITE_SERIES.includes(raw.series as string)) {
        return NextResponse.json(
          { error: 'layer applies only to suite series' },
          { status: 400 },
        );
      }
      if (value !== null && ![0, 1, 2].includes(value as number)) {
        return NextResponse.json({ error: 'layer must be 0, 1, 2 or null' }, { status: 400 });
      }
    }
    if (field === 'adoptionStatus') {
      if (
        typeof value !== 'string' ||
        !(ADOPTION_STATUS as readonly string[]).includes(value)
      ) {
        return NextResponse.json({ error: 'Invalid adoptionStatus' }, { status: 400 });
      }
      updates.adoptionStatus = value as AdoptionStatus;
    } else {
      updates[field] = value;
    }
    changedFields.push(field);
  }
  if (changedFields.length === 0) {
    return NextResponse.json(
      { error: 'No editable fields supplied' },
      { status: 400 },
    );
  }
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db
    .collection(GOVERNANCE_COLLECTION)
    .doc(params.recordId)
    .update(updates);

  // Field names only in the audit payload, never values (spec 4.2).
  await writeGovernanceAudit(
    'GOVERNANCE_RECORD_PATCHED',
    gate.auth.uid,
    params.recordId,
    { fields: changedFields },
  );

  const registrationStatus = await getRegistrationStatus(db as never);
  const updated = toGovernanceRecord(
    { ...raw, ...updates, updatedAt: new Date().toISOString() },
    registrationStatus,
  );
  return NextResponse.json({
    record: { ...updated, hasFile: !!updated.driveFileId },
  });
}
