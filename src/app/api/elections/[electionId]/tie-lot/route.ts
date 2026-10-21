import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import { recordTieLot } from "@/lib/server/election-count";

export const dynamic = "force-dynamic";

/**
 * POST tie-lot record - RO (route 14). Records an OFFLINE draw
 * (Sec 7.8): method, witnesses with presence confirmed, drawn-at and
 * outcome. The system never generates the draw.
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
    const lot = await recordTieLot(ctx.db, electionId, ctx.uid, {
      method: body.method,
      witnesses: Array.isArray(body.witnesses) ? body.witnesses : [],
      outcomeWinningCandidateUid: body.outcomeWinningCandidateUid,
      drawnAtMillis: typeof body.drawnAt === "number" ? body.drawnAt : Date.now(),
      evidence: body.evidence ?? null,
    });
    return NextResponse.json({ tieLot: lot }, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
