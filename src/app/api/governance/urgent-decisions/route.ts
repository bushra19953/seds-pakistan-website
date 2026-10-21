/**
 * President urgent decisions (ws-a §4.8).
 * POST: the National President ONLY — the service enforces the role and
 * returns 403 president_only for everyone else, INCLUDING the Founder
 * (the record must stay honest: the action is recorded as the
 * President's). A Reserved Matter class is a hard 422 block.
 * GET: list (canViewGovernance).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { submitUrgentDecision, noopUrgentNotifier, type UrgentDeps } from "@/lib/server/governance/urgent";
import { requireGovPermission, requireSessionUid, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";
import { resolveUserRole } from "@/lib/server/permissions";
import { resolveCanonicalRole, isFounder } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const submitBody = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(4000),
  decisionClassId: z.string().min(1),
  harmStatement: z.string().min(1).max(4000),
  affectedPartyUids: z.array(z.string()).max(100).optional(),
});

export function urgentDeps(): UrgentDeps {
  const deps = getGovernanceRouteDeps();
  return {
    store: deps.urgentStore,
    classes: deps.classes,
    decisions: deps.decisions,
    bodies: deps.bodies,
    bodyDirectory: deps.bodies,
    notifier: noopUrgentNotifier,
    newId: () => deps.urgentStore.nextId(),
  };
}

export async function POST(req: NextRequest) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireSessionUid(req);
    const body = submitBody.parse(await req.json());
    const storedRole = await resolveUserRole(uid);
    const result = await submitUrgentDecision(urgentDeps(), {
      actorUid: uid,
      actorRoleKey: resolveCanonicalRole(storedRole),
      isFounderActor: isFounder(uid),
      title: body.title,
      description: body.description,
      decisionClassId: body.decisionClassId,
      harmStatement: body.harmStatement,
      affectedPartyUids: body.affectedPartyUids ?? [],
      at: new Date(),
    });
    return NextResponse.json({ success: true, ...result }, { status: 201 });
  } catch (e) {
    return govErrorResponse(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const deps = getGovernanceRouteDeps();
    const decisions = await deps.urgentStore.listDecisions();
    return NextResponse.json({ success: true, decisions });
  } catch (e) {
    return govErrorResponse(e);
  }
}
