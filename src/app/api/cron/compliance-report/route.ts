/**
 * Quarterly compliance report cron (phase2_spec.md Section G.10).
 *
 * Schedule: 0 3 5 1,4,7,10 * - the 5th of Jan/Apr/Jul/Oct, i.e. five
 * days after the Oct-Sep fiscal quarter ends. SPEC PROPOSAL, flagged as
 * such: the +5 day offset is the implementation plan's proposal, not a
 * Compliance Calendar rule - it can move without touching the aggregator.
 *
 * Generates the report for the quarter that has just ended and delivers
 * it. Same fail-closed auth and flag gate as the daily compliance cron:
 * unset secret = 500, wrong secret = 401, flag off = skipped, zero
 * writes. Reports generate even for an empty quarter - a missing report
 * is the only failure.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { generateQuarterlyReport, deliverQuarterlyReport } from '@/lib/server/compliance/report-service';
import { previousQuarterKey } from '@/lib/server/compliance/report-aggregator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isPhase2Live('complianceLive'))) {
    return NextResponse.json({ ok: true, skipped: 'complianceLive off' });
  }

  const now = new Date();
  const quarterKey = previousQuarterKey(now);
  const { revision } = await generateQuarterlyReport(quarterKey, 'cron', now);
  const { deliveredTo, completedInstanceId } = await deliverQuarterlyReport(quarterKey, 'cron', now);
  await writeGovernanceAuditOrThrow({
    actorUid: 'cron',
    action: 'compliance.report_generated',
    subjectType: 'compliance_report',
    subjectId: quarterKey,
    details: { generatedBy: 'cron', revision, deliveredTo, completedInstanceId },
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, quarterKey, revision, deliveredTo, completedInstanceId });
}
