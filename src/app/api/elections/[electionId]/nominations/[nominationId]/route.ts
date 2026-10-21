import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import { decideNomination } from "@/lib/server/election-nominations";

export const dynamic = "force-dynamic";

/**
 * PATCH nomination decision - RO (route 8). Reason mandatory on
 * reject (400 without it, enforced in the server module).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string; nominationId: string }> },
) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId, nominationId } = await params;
    const body = await request.json();
    if (body.decision !== "accepted" && body.decision !== "rejected") {
      return NextResponse.json(
        { error: 'decision must be "accepted" or "rejected".', code: "bad_decision" },
        { status: 400 },
      );
    }
    const nomination = await decideNomination(
      ctx.db,
      electionId,
      nominationId,
      ctx.uid,
      body.decision,
      body.reason ?? null,
    );
    return NextResponse.json({ nomination });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
