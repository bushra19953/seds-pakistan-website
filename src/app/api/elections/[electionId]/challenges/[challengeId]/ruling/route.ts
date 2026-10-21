import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import { ruleChallenge } from "@/lib/server/election-count";

export const dynamic = "force-dynamic";

/**
 * POST challenge ruling - RO (route 17 sub-resource). The RO's
 * challenge-only authority runs to the challenge window close even
 * though the RO term ended at declaration (spec 12.2 DEFAULT).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string; challengeId: string }> },
) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId, challengeId } = await params;
    const body = await request.json();
    const effect = body.effectOnResult ?? "none";
    if (!["none", "result_amended", "election_voided"].includes(effect)) {
      return NextResponse.json(
        { error: "Invalid effectOnResult.", code: "bad_effect" },
        { status: 400 },
      );
    }
    await ruleChallenge(ctx.db, electionId, challengeId, ctx.uid, {
      ruling: body.ruling ?? "",
      effectOnResult: effect,
      upheld: body.upheld === true,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
