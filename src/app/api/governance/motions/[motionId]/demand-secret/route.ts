/**
 * Demand a secret ballot (ws-a §4.5). Any eligible present member may
 * demand; at two distinct demands the method locks to secret_ballot and
 * the lock is one-way. The response deliberately carries no running
 * vote totals of any kind.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { demandSecretBallot } from "@/lib/server/governance/ballots";
import { ballotStoreFor } from "@/lib/server/governance/motions";
import { requireSessionUid, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ motionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireSessionUid(req);
    const { motionId } = await params;
    const deps = getGovernanceRouteDeps();
    const store = ballotStoreFor(deps.motions, deps.ballots);
    const result = await demandSecretBallot(store, { motionId, uid });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return govErrorResponse(e);
  }
}
