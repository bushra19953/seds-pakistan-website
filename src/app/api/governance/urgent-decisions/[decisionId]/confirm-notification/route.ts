/**
 * Confirm Board notification of an urgent decision (ws-a §4.8, timer
 * T4). Idempotent: a second confirmation returns the record unchanged.
 * Once confirmed, the 24h Founder escalation can never fire for it.
 */

import { NextRequest, NextResponse } from "next/server";
import { confirmUrgentNotification } from "@/lib/server/governance/urgent";
import { urgentDeps } from "../../route";
import { requireSessionUid, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ decisionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireSessionUid(req);
    const { decisionId } = await params;
    const record = await confirmUrgentNotification(urgentDeps(), {
      decisionId,
      actorUid: uid,
      at: new Date(),
    });
    return NextResponse.json({ success: true, record });
  } catch (e) {
    return govErrorResponse(e);
  }
}
