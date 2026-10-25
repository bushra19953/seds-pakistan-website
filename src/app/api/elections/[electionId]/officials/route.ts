import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import {
  appointTeller,
  listOfficials,
  registerObserver,
} from "@/lib/server/election-count";

export const dynamic = "force-dynamic";

/** GET officials (tellers and observers) for an election. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ electionId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { electionId } = await params;
    const officials = await listOfficials(ctx.db, electionId);
    return NextResponse.json({ officials });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * POST officials: { action: "appoint_teller", uid, name } (RO) or
 * { action: "register_observer", uid, name, forCandidateUid }
 * (the candidate themselves).
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
    if (body.action === "appoint_teller") {
      await appointTeller(ctx.db, electionId, ctx.uid, {
        uid: body.uid,
        name: body.name,
      });
      return NextResponse.json({ ok: true }, { status: 201 });
    }
    if (body.action === "register_observer") {
      await registerObserver(ctx.db, electionId, ctx.uid, {
        uid: body.uid,
        name: body.name,
        forCandidateUid: body.forCandidateUid,
      });
      return NextResponse.json({ ok: true }, { status: 201 });
    }
    return NextResponse.json(
      { error: `Unknown action "${body.action}".`, code: "unknown_action" },
      { status: 400 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}
