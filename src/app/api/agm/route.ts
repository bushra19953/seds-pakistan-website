import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { createAgm } from "@/lib/server/agm";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/** GET /api/agm - signed in; list of AGM records. */
export async function GET(request: NextRequest) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const snap = await ctx.db
      .collection("agm_events")
      .orderBy("year", "desc")
      .get();
    return NextResponse.json({
      agms: snap.docs.map((d: { id: string; data: () => Record<string, unknown> }) => ({
        id: d.id,
        ...d.data(),
      })),
    });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** POST /api/agm - National General Secretary or Founder (route 18). */
export async function POST(request: NextRequest) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const actorMayConvene =
      isFounderUid(ctx.uid) || role === "national_general_secretary";
    const body = await request.json();
    const agm = await createAgm(ctx.db, ctx.ports, {
      actorUid: ctx.uid,
      actorMayConvene,
      year: body.year,
      title: body.title,
      scheduledAtMillis: body.scheduledAt,
      locationOrLink: body.locationOrLink,
      meetingId: body.meetingId ?? null,
      electionId: body.electionId ?? null,
    });
    return NextResponse.json({ agm }, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
