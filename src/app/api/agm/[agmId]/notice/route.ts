import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { getNoticeDelivery, issueNotice } from "@/lib/server/agm";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/**
 * POST /api/agm/[agmId]/notice { action: "issue" } - National General
 * Secretary (route 20). The 21-day rule is enforced in the server
 * module (422 when late, no override in v1).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string }> },
) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    if (!isFounderUid(ctx.uid) && role !== "national_general_secretary") {
      return NextResponse.json(
        { error: "National General Secretary or Founder only.", code: "forbidden" },
        { status: 403 },
      );
    }
    const { agmId } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.action !== undefined && body.action !== "issue") {
      return NextResponse.json(
        { error: `Unknown action "${body.action}".`, code: "unknown_action" },
        { status: 400 },
      );
    }
    const result = await issueNotice(ctx.db, ctx.ports, agmId, ctx.uid);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * GET notice dispatch + delivery proof. Per-recipient records are
 * returned to the National General Secretary and Founder only; other
 * callers receive counts by status.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { agmId } = await params;
    const delivery = await getNoticeDelivery(ctx.db, agmId);
    if (!delivery.notice) return NextResponse.json({ notice: null });
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const privileged =
      isFounderUid(ctx.uid) || role === "national_general_secretary";
    return NextResponse.json({
      notice: delivery.notice,
      deliveryCounts: delivery.deliveryCounts,
      recipients: privileged ? delivery.recipients : undefined,
    });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
