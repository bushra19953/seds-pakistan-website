/**
 * One circular resolution (ws-a §4.7): the record WITH the threshold
 * arithmetic the UI renders (majorityNeeded, signedCount, closesAt).
 * Governors see only their own signature state; the record never
 * carries another member's choice beyond the signature list the spec
 * defines. canViewGovernance.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { GovernanceServiceError } from "@/lib/server/governance/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ resolutionId: string }> },
) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const { resolutionId } = await params;
    const deps = getGovernanceRouteDeps();
    const resolution = await deps.circularStore.getResolution(resolutionId);
    if (!resolution) {
      throw new GovernanceServiceError("circular_not_found", 404, "Circular resolution not found");
    }
    return NextResponse.json({ success: true, resolution });
  } catch (e) {
    return govErrorResponse(e);
  }
}
