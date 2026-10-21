import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { writeGovernanceAudit } from '@/lib/governance/audit';
import { getRegistrationStatus } from '@/lib/governance/registration-status';
import {
  GOVERNANCE_COLLECTION,
  toGovernanceRecord,
} from '@/lib/governance/record-io';
import {
  dbUnavailable,
  requireGovernancePermission,
} from '@/lib/governance/route-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET: CSV export of the full store (spec 4.1). This is the backup of
// LAST resort; the store of record is Firestore + Drive. Filenames and
// hashes only - never Drive ids or URLs.
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db) return dbUnavailable();
  const gate = await requireGovernancePermission(request, db as never, [
    'canManageGovernanceRecords',
    'canApproveGovernanceRecords',
  ]);
  if (!gate.ok) return gate.response;

  const registrationStatus = await getRegistrationStatus(db as never);
  const snap = await db.collection(GOVERNANCE_COLLECTION).get();
  const records = snap.docs
    .map((d) =>
      toGovernanceRecord(
        d.data() as Record<string, unknown>,
        registrationStatus,
      ),
    )
    .sort((a, b) => a.recordId.localeCompare(b.recordId));

  const headers = [
    'recordId',
    'familyId',
    'series',
    'layer',
    'title',
    'version',
    'status',
    'adoptionStatus',
    'effectiveStatus',
    'accessLevel',
    'redactionStatus',
    'recordDate',
    'fileName',
    'sha256',
  ];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push(
      [
        r.recordId,
        r.familyId,
        r.series,
        r.layer,
        r.title,
        r.version,
        r.status,
        r.adoptionStatus,
        r.effectiveStatus,
        r.accessLevel,
        r.redactionStatus,
        r.recordDate,
        r.fileName,
        r.sha256,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  await writeGovernanceAudit(
    'GOVERNANCE_RECORDS_EXPORTED',
    gate.auth.uid,
    null,
    { count: records.length },
  );
  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition':
        'attachment; filename="governance-records-export.csv"',
    },
  });
}
