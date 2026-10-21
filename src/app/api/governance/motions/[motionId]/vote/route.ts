/**
 * Cast a vote on a motion (ws-a §4.5). Four kinds in one route:
 * - traceable: show of hands / electronic poll (ballot carries the uid;
 *   a duplicate cast is 409 already_voted). Proxy votes validate the
 *   authorization AND its advance resolution in the register.
 * - secret_issue: returns the one-time secret token to an eligible
 *   present member. The uid is used for eligibility and the issue log
 *   ONLY; it never touches the token or choice docs.
 * - secret_cast: authenticated, then the uid is DISCARDED before the
 *   service call — the token alone speaks.
 * - casting: the Founder's casting ballot on a tied motion.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import {
  castCastingBallot,
  castSecretBallot,
  castTraceableBallot,
  issueSecretToken,
} from "@/lib/server/governance/ballots";
import { ballotStoreFor } from "@/lib/server/governance/motions";
import {
  isFounderCaller,
  requireSessionUid,
  govErrorResponse,
} from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const choice = z.enum(["for", "against", "abstain"]);
const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("traceable"),
    choice,
    interestDisclosure: z
      .object({
        hasInterest: z.boolean(),
        description: z.string().max(500),
        relatedPartyName: z.string().nullable(),
      })
      .nullable()
      .optional(),
    proxyForUid: z.string().nullable().optional(),
    proxyAuthorizationId: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal("secret_issue") }),
  z.object({ kind: z.literal("secret_cast"), token: z.string().min(10), choice }),
  z.object({ kind: z.literal("casting"), choice }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ motionId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireSessionUid(req);
    const { motionId } = await params;
    const body = bodySchema.parse(await req.json());
    const deps = getGovernanceRouteDeps();
    const store = ballotStoreFor(deps.motions, deps.ballots);

    if (body.kind === "traceable") {
      const { ballotId } = await castTraceableBallot(store, {
        motionId,
        voterUid: uid,
        choice: body.choice,
        interestDisclosure: body.interestDisclosure ?? null,
        proxyForUid: body.proxyForUid ?? null,
        proxyAuthorizationId: body.proxyAuthorizationId ?? null,
        isEffectiveDecision: (id) => deps.decisions.isEffectiveDecision(id),
      });
      return NextResponse.json({ success: true, ballotId });
    }

    if (body.kind === "secret_issue") {
      const { token } = await issueSecretToken(store, { motionId, uid });
      return NextResponse.json({ success: true, token });
    }

    if (body.kind === "secret_cast") {
      // The uid ends here. castSecretBallot takes no voter identity.
      const { token, choice: c } = body;
      await castSecretBallot(store, { token, choice: c });
      return NextResponse.json({ success: true, accepted: true });
    }

    // casting
    const founder = await isFounderCaller(req);
    const { ballotId } = await castCastingBallot(store, {
      motionId,
      founderUid: uid,
      isFounder: founder,
      choice: body.choice,
    });
    return NextResponse.json({ success: true, ballotId });
  } catch (e) {
    return govErrorResponse(e);
  }
}
