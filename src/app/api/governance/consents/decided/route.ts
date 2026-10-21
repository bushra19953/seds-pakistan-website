/**
 * Decided Founder Consents (ws-a §4.7 support read): ONLY granted or
 * conditional consents — exactly the set the circular consent picker may
 * offer, because circulation refuses anything else. canViewGovernance.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const deps = getGovernanceRouteDeps();
    const consents = await deps.consents.listDecidedConsents();
    return NextResponse.json({ success: true, consents });
  } catch (e) {
    return govErrorResponse(e);
  }
}
