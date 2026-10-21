import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { writeGovernanceAudit } from '@/lib/governance/audit';
import { getRegistrationStatus } from '@/lib/governance/registration-status';
import {
  GOVERNANCE_COLLECTION,
  loadFamily,
  toGovernanceRecord,
} from '@/lib/governance/record-io';
import {
  dbUnavailable,
  requireGovernancePermission,
} from '@/lib/governance/route-auth';
import {
  ADOPTION_STATUS,
  REDACTION_STATUS,
  SERIES,
  isValidFamilyId,
  makeFamilyId,
  makeRecordId,
  parseFamilyId,
  type AdoptionStatus,
  type GovernanceSeries,
  type RedactionStatus,
} from '@/lib/governance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// System-only fields a client may never supply on create (spec 3.2 / 4.1).
const FORBIDDEN_CREATE_FIELDS = [
  'recordId',
  'version',
  'supersedesRecordId',
  'supersededByRecordId',
  'status',
  'effectiveStatus',
  'driveFileId',
  'driveUrl',
  'driveFolderId',
  'fileName',
  'mimeType',
  'sizeBytes',
  'sha256',
  'uploadedBy',
  'approvedBy',
  'consentId',
  'createdAt',
  'updatedAt',
] as const;

function badRequest(error: string, code?: string) {
  return NextResponse.json(
    code ? { error, code } : { error },
    { status: 400 },
  );
}

// GET: admin list (spec 4.1). Gate: manage OR approve.
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db) return dbUnavailable();
  const gate = await requireGovernancePermission(request, db as never, [
    'canManageGovernanceRecords',
    'canApproveGovernanceRecords',
  ]);
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const series = params.get('series');
  const status = params.get('status');
  const accessLevel = params.get('accessLevel');
  const familyId = params.get('familyId');
  const q = params.get('q');
  const limit = Math.min(
    Math.max(Number(params.get('limit') ?? 50) || 50, 1),
    200,
  );
  const cursor = params.get('cursor');

  // The records store is small by design (governance documents, not user
  // content), so filtered in-memory paging over one collection read is
  // honest and keeps cursor semantics exact.
  const snap = await db.collection(GOVERNANCE_COLLECTION).get();
  const registrationStatus = await getRegistrationStatus(db as never);
  let records = snap.docs.map((d) =>
    toGovernanceRecord(
      d.data() as Record<string, unknown>,
      registrationStatus,
    ),
  );
  if (series) records = records.filter((r) => r.series === series);
  if (status) records = records.filter((r) => r.status === status);
  if (accessLevel)
    records = records.filter((r) => r.accessLevel === accessLevel);
  if (familyId) records = records.filter((r) => r.familyId === familyId);
  if (q) records = records.filter((r) => r.title.startsWith(q));
  records.sort((a, b) =>
    b.recordDate === a.recordDate
      ? b.recordId.localeCompare(a.recordId)
      : b.recordDate.localeCompare(a.recordDate),
  );
  let start = 0;
  if (cursor) {
    const idx = records.findIndex((r) => r.recordId === cursor);
    if (idx >= 0) start = idx + 1;
  }
  const page = records.slice(start, start + limit);
  const nextCursor =
    start + limit < records.length ? page[page.length - 1].recordId : null;
  return NextResponse.json({
    records: page.map((r) => ({ ...r, hasFile: !!r.driveFileId })),
    nextCursor,
  });
}

// POST: create a record - version 1 of a new family, or a new version of
// an existing family (spec 4.1). Gate: canManageGovernanceRecords.
export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db) return dbUnavailable();
  const gate = await requireGovernancePermission(request, db as never, [
    'canManageGovernanceRecords',
  ]);
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) return badRequest('Invalid JSON body');
  for (const field of FORBIDDEN_CREATE_FIELDS) {
    if (field in body) {
      return badRequest(
        `Field '${field}' is system-assigned and must not be supplied`,
      );
    }
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const parties = Array.isArray(body.parties)
    ? (body.parties as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      )
    : [];
  const recordDate =
    typeof body.recordDate === 'string' ? body.recordDate : '';
  if (!recordDate || Number.isNaN(Date.parse(recordDate))) {
    return badRequest('recordDate (ISO date) is required');
  }
  // Access level is born officer_only, always (spec 4.1). Anything else
  // must go through the transition route so the guard and audit run.
  if (
    body.accessLevel !== undefined &&
    body.accessLevel !== 'officer_only'
  ) {
    return badRequest(
      'accessLevel is always officer_only at creation; use the transition route to change it',
    );
  }
  let redactionStatus: RedactionStatus = 'UNREDACTED_DO_NOT_PUBLISH';
  if (body.redactionStatus !== undefined) {
    if (
      typeof body.redactionStatus !== 'string' ||
      !(REDACTION_STATUS as readonly string[]).includes(body.redactionStatus)
    ) {
      return badRequest('Invalid redactionStatus');
    }
    redactionStatus = body.redactionStatus as RedactionStatus;
  }
  let adoptionStatus: AdoptionStatus = 'not_adopted';
  if (body.adoptionStatus !== undefined) {
    if (
      typeof body.adoptionStatus !== 'string' ||
      !(ADOPTION_STATUS as readonly string[]).includes(body.adoptionStatus)
    ) {
      return badRequest('Invalid adoptionStatus');
    }
    adoptionStatus = body.adoptionStatus as AdoptionStatus;
  }
  const notes = typeof body.notes === 'string' ? body.notes : '';
  const links =
    body.links && typeof body.links === 'object'
      ? (body.links as Record<string, unknown>)
      : {};

  // Resolve family: existing familyId for a new version, or slug+series
  // for a new family.
  let familyId: string;
  let series: GovernanceSeries;
  let layer: number | null;
  const existingFamily = await (async () => {
    if (typeof body.familyId === 'string' && body.familyId) {
      if (!isValidFamilyId(body.familyId)) {
        return { error: badRequest('Invalid familyId') };
      }
      const rows = await loadFamily(db as never, body.familyId);
      if (rows.length === 0) {
        return {
          error: NextResponse.json(
            { error: 'Family not found' },
            { status: 404 },
          ),
        };
      }
      return { rows };
    }
    return null;
  })();
  if (existingFamily && 'error' in existingFamily) return existingFamily.error;

  if (existingFamily && 'rows' in existingFamily) {
    familyId = body.familyId as string;
    const first = existingFamily.rows[0] as unknown as {
      series: GovernanceSeries;
      layer: number | null;
    };
    series = first.series;
    layer = first.layer ?? null;
    if (body.series !== undefined && body.series !== series) {
      return badRequest(
        'series is fixed by the family and cannot change between versions',
      );
    }
  } else {
    if (
      typeof body.series !== 'string' ||
      !(SERIES as readonly string[]).includes(body.series)
    ) {
      return badRequest('A valid series is required for a new family');
    }
    series = body.series as GovernanceSeries;
    if (typeof body.slug !== 'string' || !body.slug) {
      return badRequest('A slug is required for a new family');
    }
    try {
      familyId = makeFamilyId(series, body.slug);
    } catch (e) {
      return badRequest((e as Error).message);
    }
    const clash = await loadFamily(db as never, familyId);
    if (clash.length > 0) {
      return NextResponse.json(
        {
          error:
            'A family with this slug already exists; pick a different slug or create a new version of the existing family',
          code: 'family-exists',
        },
        { status: 409 },
      );
    }
    layer =
      typeof body.layer === 'number' && [0, 1, 2].includes(body.layer)
        ? body.layer
        : null;
    if (!title) return badRequest('title is required for a new family');
  }

  const parsed = parseFamilyId(familyId);
  if (!parsed) return badRequest('Invalid familyId');
  const familyRows = existingFamily && 'rows' in existingFamily
    ? existingFamily.rows
    : [];
  const version =
    familyRows.length === 0
      ? 1
      : Math.max(
          ...familyRows.map((r) => Number(r.version ?? 0)),
        ) + 1;
  const recordId = makeRecordId(familyId, version);
  const latest =
    familyRows.length === 0
      ? null
      : familyRows[familyRows.length - 1];

  const now = admin.firestore.FieldValue.serverTimestamp();
  const docData: Record<string, unknown> = {
    recordId,
    familyId,
    series,
    layer,
    title: title || (latest?.title as string) || '',
    parties,
    recordDate,
    version,
    supersedesRecordId: latest
      ? (latest.recordId as string)
      : null,
    supersededByRecordId: null,
    status: 'draft',
    adoptionStatus,
    // Placeholder; the stored value is never trusted - reads recompute.
    effectiveStatus: 'not_applicable',
    driveFileId: null,
    driveUrl: null,
    driveFolderId: null,
    fileName: null,
    mimeType: null,
    sizeBytes: null,
    sha256: null,
    uploadedBy: gate.auth.uid,
    approvedBy: null,
    consentId: null,
    accessLevel: 'officer_only',
    redactionStatus,
    redactedFromRecordId:
      typeof body.redactedFromRecordId === 'string'
        ? body.redactedFromRecordId
        : null,
    links,
    notes,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(GOVERNANCE_COLLECTION).doc(recordId).set(docData);

  await writeGovernanceAudit(
    'GOVERNANCE_RECORD_CREATED',
    gate.auth.uid,
    recordId,
    { familyId, series, version, redactionStatus },
  );

  const registrationStatus = await getRegistrationStatus(db as never);
  const record = toGovernanceRecord(
    { ...docData, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    registrationStatus,
  );
  return NextResponse.json(
    { record: { ...record, hasFile: false } },
    { status: 201 },
  );
}
