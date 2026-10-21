import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import {
  publishTimetable,
  updateTimetable,
  transitionElection,
  type ElectionTransition,
} from "@/lib/server/elections";
import { getElectionOrThrow, millisOf } from "@/lib/server/election-db";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/**
 * GET /api/elections/[electionId] - audience filtered (route 3).
 * Drafts: RO / Founder / National General Secretary only. Members
 * never receive the turnout counters before declaration.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const election = await getElectionOrThrow(ctx.db, electionId);
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const privileged =
      isFounderUid(ctx.uid) ||
      election.returningOfficerUid === ctx.uid ||
      role === "national_general_secretary";
    if (election.status === "draft" && !privileged) {
      return NextResponse.json(
        { error: "Election not found.", code: "election_not_found" },
        { status: 404 },
      );
    }
    const body: Record<string, unknown> = { ...election };
    if (!privileged && election.status !== "declared" && election.status !== "closed") {
      // Counters stay hidden from members until the result is declared.
      delete body.counters;
    }
    return NextResponse.json({ election: body });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * PATCH /api/elections/[electionId] - RO (route 4).
 * Body: { action: "publish_timetable" | "update_timetable" |
 *         "open_nominations" | "close_nominations" | "open_poll" |
 *         "close_poll" | "cancel", ... }
 */
export async function PATCH(
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
    const action = body.action as string;
    if (action === "publish_timetable") {
      const election = await publishTimetable(ctx.db, electionId, ctx.uid, {
        lateReason: body.lateReason ?? null,
      });
      return NextResponse.json({ election });
    }
    if (action === "update_timetable") {
      const patch: Record<string, number> = {};
      for (const key of [
        "nominationOpenAt",
        "nominationCloseAt",
        "candidateListDate",
        "pollOpenAt",
        "pollCloseAt",
      ]) {
        if (typeof body[key] === "number") patch[key] = body[key];
      }
      const election = await updateTimetable(ctx.db, electionId, ctx.uid, patch);
      return NextResponse.json({ election });
    }
    const transitions: ElectionTransition[] = [
      "open_nominations",
      "close_nominations",
      "open_poll",
      "close_poll",
      "cancel",
    ];
    if (transitions.includes(action as ElectionTransition)) {
      const election = await transitionElection(
        ctx.db,
        electionId,
        ctx.uid,
        action as ElectionTransition,
        { reason: body.reason ?? null },
      );
      return NextResponse.json({ election });
    }
    void millisOf;
    return NextResponse.json(
      { error: `Unknown action "${action}".`, code: "unknown_action" },
      { status: 400 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}
