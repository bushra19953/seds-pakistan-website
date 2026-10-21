import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { buildRoll, freezeRoll, getRollEntry } from "@/lib/server/election-roll";
import { getElectionOrThrow } from "@/lib/server/election-db";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/** POST /api/elections/[electionId]/roll { action: "build" | "freeze" } - RO (route 5). */
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
    if (body.action === "build") {
      const result = await buildRoll(ctx.db, ctx.ports, electionId, ctx.uid);
      return NextResponse.json(result);
    }
    if (body.action === "freeze") {
      const result = await freezeRoll(ctx.db, electionId, ctx.uid);
      return NextResponse.json(result);
    }
    return NextResponse.json(
      { error: `Unknown action "${body.action}".`, code: "unknown_action" },
      { status: 400 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * GET roll - ?self=1 returns only the caller's own entry; RO / Founder /
 * National General Secretary get the summary (never other members'
 * entries over this route beyond counts).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const self = request.nextUrl.searchParams.get("self");
    if (self) {
      const entry = await getRollEntry(ctx.db, electionId, ctx.uid);
      return NextResponse.json({ entry });
    }
    const election = await getElectionOrThrow(ctx.db, electionId);
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const privileged =
      isFounderUid(ctx.uid) ||
      election.returningOfficerUid === ctx.uid ||
      role === "national_general_secretary";
    if (!privileged) {
      return NextResponse.json(
        { error: "Forbidden", code: "forbidden" },
        { status: 403 },
      );
    }
    return NextResponse.json({ voterRoll: election.voterRoll });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
