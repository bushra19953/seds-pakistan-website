import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import { issueBallotToken } from "@/lib/server/election-ballot";

export const dynamic = "force-dynamic";

/**
 * POST ballot token - signed in, on the frozen roll (route 10).
 * The plaintext token is returned ONCE over this authenticated
 * response (Cache-Control: no-store). It is never stored or logged.
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
    const { token } = await issueBallotToken(ctx.db, electionId, ctx.uid, {
      reissue: body.reissue === true,
    });
    const res = NextResponse.json({ token }, { status: 201 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return electionErrorResponse(err);
  }
}
