/**
 * Link a passed approval motion to minutes (ws-a §6.3). The service
 * verifies the motion itself: closed_passed AND minutesApprovalFor
 * naming this record. The motions close route also calls this when a
 * closing motion carries minutesApprovalFor.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { linkMinutesApproval } from "@/lib/server/governance/minutes";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({ approvalMotionId: z.string().min(1) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ minutesId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    await requireGovPermission(req, "canManageMeetings");
    const { minutesId } = await params;
    const { approvalMotionId } = body.parse(await req.json());
    const deps = getGovernanceRouteDeps();
    const minutes = await linkMinutesApproval(
      { store: deps.minutesStore, motions: deps.motions, pdfPipeline: deps.minutesPdfPipeline },
      { minutesId, approvalMotionId, at: new Date() },
    );
    return NextResponse.json({ success: true, minutes });
  } catch (e) {
    return govErrorResponse(e);
  }
}
