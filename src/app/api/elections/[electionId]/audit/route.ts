import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { listElectionAudit } from "@/lib/server/election-audit";
import { getElectionOrThrow } from "@/lib/server/election-db";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/**
 * GET the election's server audit entries (RO console Audit tab).
 * Gate: the election's RO, the Founder, or the National General
 * Secretary. Payloads never contain ballot tokens or choices.
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
    const allowed =
      election.returningOfficerUid === ctx.uid ||
      isFounderUid(ctx.uid) ||
      role === "national_general_secretary";
    if (!allowed) {
      return NextResponse.json(
        { error: "Forbidden", code: "forbidden" },
        { status: 403 },
      );
    }
    const entries = await listElectionAudit(ctx.db, electionId);
    return NextResponse.json({ entries });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
