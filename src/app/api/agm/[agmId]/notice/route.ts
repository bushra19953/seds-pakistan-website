import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { issueNotice } from "@/lib/server/agm";
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
    const noticesSnap = await ctx.db
      .collection("agm_events")
      .doc(agmId)
      .collection("notices")
      .get();
    if (noticesSnap.empty) return NextResponse.json({ notice: null });
    const noticeDoc = noticesSnap.docs[0];
    const notice = { id: noticeDoc.id, ...noticeDoc.data() };
    const recipientsSnap = await noticeDoc.ref.collection("recipients").get();
    const counts: Record<string, number> = {};
    for (const r of recipientsSnap.docs) {
      const s = r.data().deliveryStatus?.inApp ?? "unknown";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const privileged =
      isFounderUid(ctx.uid) || role === "national_general_secretary";
    return NextResponse.json({
      notice,
      deliveryCounts: counts,
      recipients: privileged
        ? recipientsSnap.docs.map(
            (r: { id: string; data: () => Record<string, unknown> }) => ({
              id: r.id,
              ...r.data(),
            }),
          )
        : undefined,
    });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
