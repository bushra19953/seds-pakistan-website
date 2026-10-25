import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { createElection } from "@/lib/server/elections";
import { listAllElectionDocs } from "@/lib/server/election-db";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/**
 * GET /api/elections - signed in. Members see published elections;
 * RO, Founder and National General Secretary also see drafts.
 * Summaries only: no roll, no ballot data.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const privileged =
      isFounderUid(ctx.uid) ||
      role === "returning_officer" ||
      role === "national_general_secretary";
    const docs = await listAllElectionDocs(ctx.db);
    const out: Array<Record<string, unknown>> = [];
    for (const d of docs) {
      const e = d.data;
      const mine = e.returningOfficerUid === ctx.uid;
      if (e.status === "draft" && !privileged && !mine) continue;
      out.push({
        id: d.id,
        title: e.title,
        kind: e.kind,
        seatCategory: e.seatCategory,
        seats: e.seats,
        status: e.status,
        returningOfficerName: e.returningOfficerName,
        timetable: e.timetable,
        agmId: e.agmId ?? null,
      });
    }
    return NextResponse.json({ elections: out });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** POST /api/elections - Founder only (route 1). */
export async function POST(request: NextRequest) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const body = await request.json();
    const election = await createElection(ctx.db, ctx.ports, {
      actorUid: ctx.uid,
      actorIsFounder: isFounderUid(ctx.uid),
      title: body.title,
      kind: body.kind,
      seatCategory: body.seatCategory,
      seats: body.seats,
      electionDayMillis: body.electionDay,
      returningOfficerUid: body.returningOfficerUid,
      returningOfficerName: body.returningOfficerName,
      agmId: body.agmId ?? null,
      campaignCodeUrl: body.campaignCodeUrl ?? null,
      campaignCodeDriveFileId: body.campaignCodeDriveFileId ?? null,
    });
    return NextResponse.json(
      { electionId: election.id, timetable: election.timetable },
      { status: 201 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}
