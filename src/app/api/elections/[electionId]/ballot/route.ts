import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import { castBallot, getTurnout } from "@/lib/server/election-ballot";

export const dynamic = "force-dynamic";

/**
 * POST cast ballot (route 11). Bearer session (marker check) plus the
 * ballot token (authorises the choice). The response is deliberately
 * minimal: { recorded, castDay } - no ballot id, no choice echo, no
 * receipt that encodes the vote.
 */
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
    const result = await castBallot(ctx.db, electionId, {
      uid: ctx.uid,
      token: body.token,
      choices: Array.isArray(body.choices) ? body.choices : [],
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** GET turnout counters only (route 12). No individual ballot is ever returned. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const turnout = await getTurnout(ctx.db, electionId);
    return NextResponse.json({ turnout });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
