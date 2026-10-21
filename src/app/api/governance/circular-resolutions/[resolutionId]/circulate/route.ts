/**
 * Circulate a draft resolution (ws-a §4.7): opens the 7-day window.
 * Refuses when the linked Founder Consent is absent, pending, or
 * refused (422 consent_not_decided). Caller must be the creator, the
 * body chair, or the Founder (service-enforced).
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { circulateCircular, noopCircularNotifier } from "@/lib/server/governance/circular";
import {
  isFounderCaller,
  requireGovPermission,
  govErrorResponse,
} from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ resolutionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireGovPermission(req, "canManageMeetings");
    const { resolutionId } = await params;
    const deps = getGovernanceRouteDeps();
    const resolution = await circulateCircular(
      {
        store: deps.circularStore,
        bodies: deps.bodies,
        classes: deps.classes,
        consents: deps.consents,
        decisions: deps.decisions,
        filingTasks: deps.filingTasks,
        notifier: noopCircularNotifier,
      },
      { resolutionId, actorUid: uid, isFounder: await isFounderCaller(req), at: new Date() },
    );
    return NextResponse.json({ success: true, resolution });
  } catch (e) {
    return govErrorResponse(e);
  }
}
