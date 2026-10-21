/**
 * GET /api/cron/compliance (phase2_spec.md Section G.5).
 *
 * Daily at 03:45 UTC (vercel.json). CRON_SECRET Bearer auth, fail-closed:
 * an unset CRON_SECRET is a 500, a wrong secret a 401 - the guard shape
 * follows check-deadlines, tightened to cron-only because this engine
 * moves governance state.
 *
 * Gated on the complianceLive flag: off -> { ok: true, skipped } with
 * zero writes. The run summary is written to audit_logs and returned.
 *
 * This route is deliberately separate from check-deadlines: the
 * compliance engine never touches the member discipline machinery, and a
 * grep test (separation.test.ts) enforces the boundary both ways.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { runComplianceCron } from '@/lib/server/compliance/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured' },
      { status: 500 },
    );
  }
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const live = await isPhase2Live('complianceLive').catch(() => false);
  if (!live) {
    return NextResponse.json({ ok: true, skipped: 'complianceLive off' });
  }

  const summary = await runComplianceCron(new Date());

  try {
    await writeGovernanceAuditOrThrow({
      actorUid: 'system:compliance-cron',
      action: 'compliance.cron_run',
      subjectType: 'compliance_cron',
      subjectId: 'daily',
      details: {
        ok: summary.ok,
        passes: Object.fromEntries(
          Object.entries(summary.passes).map(([k, v]) => [k, { ok: v.ok, counts: v.counts }]),
        ),
      },
    });
  } catch {
    // The JSON response below still carries the run's truth.
    return NextResponse.json({ ...summary, auditWriteFailed: true });
  }

  return NextResponse.json(summary);
}
