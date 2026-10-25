import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { fileChallenge, listChallenges } from "@/lib/server/election-count";
import { getElectionOrThrow } from "@/lib/server/election-db";

export const dynamic = "force-dynamic";

/** GET challenges: RO and Founder see all; a member sees their own. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const election = await getElectionOrThrow(ctx.db, electionId);
    const all = await listChallenges(ctx.db, electionId);
    const privileged =
      election.returningOfficerUid === ctx.uid || isFounderUid(ctx.uid);
    return NextResponse.json({
      challenges: privileged
        ? all
        : all.filter((c) => c.challengerUid === ctx.uid),
    });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** POST file a challenge - roll members only (route 17). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const body = await request.json();
    const result = await fileChallenge(
      ctx.db,
      electionId,
      ctx.uid,
      body.grounds ?? "",
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
