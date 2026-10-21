import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import {
  declareResult,
  retryGovernorWriteback,
  getResult,
} from "@/lib/server/election-count";

export const dynamic = "force-dynamic";

/** GET the declared result (null until declaration). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const result = await getResult(ctx.db, electionId);
    return NextResponse.json({ result });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * POST declare - RO (route 15). Body { action: "declare" } or
 * { action: "retry_writeback" } for a failed Board register writeback.
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
    const body = await request.json().catch(() => ({}));
    if (body.action === "retry_writeback") {
      const result = await retryGovernorWriteback(
        ctx.db,
        ctx.ports,
        electionId,
        ctx.uid,
      );
      return NextResponse.json({ result });
    }
    const result = await declareResult(ctx.db, ctx.ports, electionId, ctx.uid, {
      verificationBaseUrl:
        process.env.NEXT_PUBLIC_SITE_URL ?? "https://sedspakistan.live",
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
