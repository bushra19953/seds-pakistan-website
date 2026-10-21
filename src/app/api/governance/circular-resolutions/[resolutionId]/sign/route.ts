/**
 * Sign (or vote against / abstain on) a circular resolution (ws-a §4.7).
 * The caller's identity comes from the session, never the body. A "for"
 * signature records the exact approval statement. Signing after the
 * threshold is reached closes the resolution passed IMMEDIATELY
 * (fraction-of-all classes); a second signature is 409 already_signed
 * with no state change.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { signCircular, voteCircular, noopCircularNotifier } from "@/lib/server/governance/circular";
import { requireSessionUser, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({ choice: z.enum(["for", "against", "abstain"]) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ resolutionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const user = await requireSessionUser(req);
    const { resolutionId } = await params;
    const { choice } = body.parse(await req.json());
    const deps = getGovernanceRouteDeps();
    const circularDeps = {
      store: deps.circularStore,
      bodies: deps.bodies,
      classes: deps.classes,
      consents: deps.consents,
      decisions: deps.decisions,
      filingTasks: deps.filingTasks,
      notifier: noopCircularNotifier,
    };
    const result =
      choice === "for"
        ? await signCircular(circularDeps, {
            resolutionId,
            uid: user.uid,
            displayName: user.displayName,
            at: new Date(),
          })
        : await voteCircular(circularDeps, {
            resolutionId,
            uid: user.uid,
            displayName: user.displayName,
            choice,
            at: new Date(),
          });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return govErrorResponse(e);
  }
}
