import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import { getAgmDocumentForUser } from "@/lib/server/agm";

export const dynamic = "force-dynamic";

/**
 * GET one document (route 21). Re-checks Full Member status; the
 * stored Drive link is returned only to Full Members. (A streaming
 * download proxy can replace the link hand-off without changing the
 * gate; the link is never public.)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string; documentId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { documentId } = await params;
    const isFull = await ctx.ports.fullMembers.isFullMember(ctx.uid);
    const doc = await getAgmDocumentForUser(ctx.db, documentId, {
      isFullMember: isFull,
    });
    return NextResponse.json({ document: doc });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
