import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import {
  certifyCandidates,
  listCertifiedCandidates,
} from "@/lib/server/election-nominations";

export const dynamic = "force-dynamic";

/** GET certified candidate list (route 9). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const certified = await listCertifiedCandidates(ctx.db, electionId);
    return NextResponse.json({
      candidates: certified.map((n) => ({
        candidateUid: n.candidateUid,
        candidateName: n.candidateName,
        candidateStatement: n.candidateStatement,
        certifiedAt: n.certifiedAt,
      })),
    });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** POST { action: "certify" } - RO (route 9). */
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
    if (body.action !== "certify") {
      return NextResponse.json(
        { error: `Unknown action "${body.action}".`, code: "unknown_action" },
        { status: 400 },
      );
    }
    const result = await certifyCandidates(ctx.db, ctx.ports, electionId, ctx.uid);
    return NextResponse.json(result);
  } catch (err) {
    return electionErrorResponse(err);
  }
}
