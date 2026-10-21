/**
 * POST /api/admin/compliance/reports/[quarterKey]/generate (G.10).
 * Manual (re)generation - Founder or NGS. Regeneration REVISES the same
 * compliance_reports doc (revision + 1); it never creates a second doc
 * and never appends to deliveryHistory.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { isNgs } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { generateQuarterlyReport } from '@/lib/server/compliance/report-service';
import { parseQuarterKey } from '@/lib/server/compliance/report-aggregator';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ quarterKey: string }> },
) {
  try {
    const uid = await requireUid(req);
    const { quarterKey } = await params;
    if (!parseQuarterKey(quarterKey)) return errorJson(400, 'INVALID_QUARTER_KEY');
    if (!isFounderUid(uid) && !(await isNgs(uid))) return errorJson(403, 'FORBIDDEN');
    const { report, revision, pdfUrl } = await generateQuarterlyReport(quarterKey, 'manual');
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.report_generated',
      subjectType: 'compliance_report',
      subjectId: quarterKey,
      details: { generatedBy: 'manual', revision },
    });
    return NextResponse.json({ ok: true, quarterKey, revision, pdfUrl, summary: report.summary });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    console.error('[compliance/reports/generate] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
