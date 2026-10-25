import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import {
  openCount,
  signOffCount,
  getCountRecord,
  isElectionOfficial,
} from "@/lib/server/election-count";
import { getElectionOrThrow } from "@/lib/server/election-db";

export const dynamic = "force-dynamic";

/**
 * GET count record: RO, tellers and observers during the count; all
 * signed-in members after declaration (tallies only - the count route
 * never returns ballot documents).
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
    const record = await getCountRecord(ctx.db, electionId);
    if (!record) return NextResponse.json({ count: null });
    const declared =
      election.status === "declared" || election.status === "closed";
    const isOfficial = await isElectionOfficial(ctx.db, electionId, ctx.uid);
    const allowed =
      declared ||
      isOfficial ||
      isFounderUid(ctx.uid) ||
      election.returningOfficerUid === ctx.uid;
    if (!allowed) {
      return NextResponse.json(
        { error: "The count is not public yet.", code: "forbidden" },
        { status: 403 },
      );
    }
    return NextResponse.json({ count: record });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** POST count: { action: "open" } (RO) or { action: "sign_off" } (RO/tellers) - route 13. */
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
    if (body.action === "open") {
      const record = await openCount(ctx.db, electionId, ctx.uid);
      return NextResponse.json({ count: record }, { status: 201 });
    }
    if (body.action === "sign_off") {
      const record = await signOffCount(ctx.db, electionId, ctx.uid);
      return NextResponse.json({ count: record });
    }
    return NextResponse.json(
      { error: `Unknown action "${body.action}".`, code: "unknown_action" },
      { status: 400 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}
