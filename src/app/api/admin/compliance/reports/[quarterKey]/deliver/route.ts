/**
 * POST /api/admin/compliance/reports/[quarterKey]/deliver (G.10).
 * Manual delivery - Founder or NGS. Each actual delivery appends one
 * deliveryHistory entry and completes an open quarterly-compliance-report
 * instance for the quarter exactly once (completedVia 'report_delivery').
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireUid, sessionErrorResponse, errorJson } from '@/lib/server/compliance/http';
import { isNgs } from '@/lib/server/compliance/access';
import { isFounderUid } from '@/lib/server/founder-gate';
import { deliverQuarterlyReport } from '@/lib/server/compliance/report-service';
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
    const { deliveredTo, completedInstanceId } = await deliverQuarterlyReport(quarterKey, uid);
    await writeGovernanceAuditOrThrow({
      actorUid: uid,
      action: 'compliance.report_delivered',
      subjectType: 'compliance_report',
      subjectId: quarterKey,
      details: { deliveredTo, completedInstanceId },
    });
    return NextResponse.json({ ok: true, quarterKey, deliveredTo, completedInstanceId });
  } catch (err) {
    const session = sessionErrorResponse(err);
    if (session) return session;
    if (err instanceof Error && err.message === 'REPORT_NOT_GENERATED') {
      return errorJson(409, 'REPORT_NOT_GENERATED');
    }
    console.error('[compliance/reports/deliver] failed:', err);
    return errorJson(500, 'INTERNAL');
  }
}
