/**
 * Record the ratifying body's ratification of an urgent decision
 * (ws-a §4.8). The caller must belong to the ratifying body; the named
 * decisions entry must exist, match the class, belong to that body,
 * and have outcome passed or effective (422 ratification_decision_invalid
 * otherwise). Success flips BOTH the urgent record and the register
 * entry to ratified.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { ratifyUrgentDecision } from "@/lib/server/governance/urgent";
import { urgentDeps } from "../../route";
import { requireSessionUid, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  ratificationDecisionId: z.string().min(1),
  ratificationMotionId: z.string().nullable().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ decisionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireSessionUid(req);
    const { decisionId } = await params;
    const parsed = body.parse(await req.json());
    const deps = getGovernanceRouteDeps();
    const memberships = await deps.bodies.listBodiesForMember(uid);
    const record = await ratifyUrgentDecision(urgentDeps(), {
      decisionId,
      ratificationDecisionId: parsed.ratificationDecisionId,
      ratificationMotionId: parsed.ratificationMotionId ?? null,
      actorUid: uid,
      actorBodyIds: memberships.map((b) => b.id),
      at: new Date(),
    });
    return NextResponse.json({ success: true, record });
  } catch (e) {
    return govErrorResponse(e);
  }
}
