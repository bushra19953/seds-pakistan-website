/**
 * Motions of a meeting (ws-a §4.5).
 * POST: open a motion — canManageMeetings + the service enforces chair.
 * GET: list the meeting's motions — canViewGovernance.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { openMotion } from "@/lib/server/governance/motions";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const openBody = z.object({
  text: z.string().min(1).max(4000),
  decisionClassId: z.string().min(1),
  proposerUid: z.string().min(1),
  method: z.enum(["show_of_hands", "electronic_poll", "secret_ballot"]).optional(),
  subjectRef: z.string().nullable().optional(),
  minutesApprovalFor: z.string().nullable().optional(),
  supersedesDecisionId: z.string().nullable().optional(),
  reversesDecisionId: z.string().nullable().optional(),
  consentId: z.string().nullable().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireGovPermission(req, "canManageMeetings");
    const { meetingId } = await params;
    const body = openBody.parse(await req.json());
    const deps = getGovernanceRouteDeps();
    const { motion, matrixWarning } = await openMotion(
      {
        motions: deps.motions,
        ballots: deps.ballots,
        meetings: deps.meetings,
        attendance: deps.attendance,
        bodies: deps.bodies,
        classes: deps.classes,
        decisions: deps.decisions,
        filingTasks: deps.filingTasks,
        newId: () => deps.motions.nextId(),
      },
      { meetingId, actorUid: uid, at: new Date(), ...body, method: body.method },
    );
    return NextResponse.json({ success: true, motion, matrixWarning }, { status: 201 });
  } catch (e) {
    return govErrorResponse(e);
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const { meetingId } = await params;
    const deps = getGovernanceRouteDeps();
    const motions = await deps.motions.listMotionsByMeeting(meetingId);
    return NextResponse.json({ success: true, motions });
  } catch (e) {
    return govErrorResponse(e);
  }
}
