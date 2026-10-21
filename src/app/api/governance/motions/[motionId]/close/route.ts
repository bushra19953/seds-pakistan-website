/**
 * Close a motion (ws-a §4.5): counts the ballots, applies the copied
 * threshold, parks Board/Council ties for the Founder casting ballot,
 * and on final close writes the decisions register entry (passed AND
 * failed) plus any filing task.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { closeMotion } from "@/lib/server/governance/motions";
import { linkMinutesApproval } from "@/lib/server/governance/minutes";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ motionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireGovPermission(req, "canManageMeetings");
    const { motionId } = await params;
    const deps = getGovernanceRouteDeps();
    const result = await closeMotion(
      {
        motions: deps.motions,
        ballots: deps.ballots,
        meetings: deps.meetings,
        attendance: deps.attendance,
        bodies: deps.bodies,
        classes: deps.classes,
        decisions: deps.decisions,
        filingTasks: deps.filingTasks,
      },
      { motionId, actorUid: uid, at: new Date() },
    );
    // ws-a §6.3: a motion opened with minutesApprovalFor IS the minutes
    // approval flow — link it on final close (never on a parked tie).
    let minutesApproval: { minutesId: string; status: string } | null = null;
    if (!result.tied && result.status === "closed_passed") {
      const motion = await deps.motions.getMotion(motionId);
      if (motion?.minutesApprovalFor) {
        const minutes = await linkMinutesApproval(
          { store: deps.minutesStore, motions: deps.motions, pdfPipeline: deps.minutesPdfPipeline },
          { minutesId: motion.minutesApprovalFor, approvalMotionId: motionId, at: new Date() },
        );
        minutesApproval = { minutesId: minutes.id, status: minutes.status };
      }
    }
    return NextResponse.json({ success: true, ...result, minutesApproval });
  } catch (e) {
    return govErrorResponse(e);
  }
}
