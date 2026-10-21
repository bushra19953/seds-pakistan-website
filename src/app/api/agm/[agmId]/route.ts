import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { getAgmOrThrow, updateAgenda, finaliseAgenda } from "@/lib/server/agm";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

async function requireNgsContext(request: NextRequest) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const role = await resolveCanonicalRole(ctx.db, ctx.uid);
  if (!isFounderUid(ctx.uid) && role !== "national_general_secretary") {
    return NextResponse.json(
      { error: "National General Secretary or Founder only.", code: "forbidden" },
      { status: 403 },
    );
  }
  return ctx;
}

/** GET /api/agm/[agmId] - detail. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { agmId } = await params;
    const agm = await getAgmOrThrow(ctx.db, agmId);
    return NextResponse.json({ agm });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * PATCH /api/agm/[agmId] - National General Secretary (route 19).
 * { action: "update_agenda", agenda } or { action: "finalise_agenda" }.
 * Finalising without the election item while seats are due returns
 * 422 election_item_required (server module).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string }> },
) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireNgsContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { agmId } = await params;
    const body = await request.json();
    if (body.action === "update_agenda") {
      const agm = await updateAgenda(ctx.db, agmId, ctx.uid, body.agenda ?? []);
      return NextResponse.json({ agm });
    }
    if (body.action === "finalise_agenda") {
      const agm = await finaliseAgenda(ctx.db, agmId, ctx.uid);
      return NextResponse.json({ agm });
    }
    return NextResponse.json(
      { error: `Unknown action "${body.action}".`, code: "unknown_action" },
      { status: 400 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}
