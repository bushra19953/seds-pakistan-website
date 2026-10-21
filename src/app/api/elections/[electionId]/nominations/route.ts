import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
} from "@/lib/server/election-route-helpers";
import {
  submitNomination,
  listNominations,
} from "@/lib/server/election-nominations";
import { getElectionOrThrow } from "@/lib/server/election-db";

export const dynamic = "force-dynamic";

/**
 * GET nominations - audience filtered: the RO sees the vetting queue;
 * a member sees only nominations they are party to (candidate or
 * nominator).
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
    const all = await listNominations(ctx.db, electionId);
    const isRo = election.returningOfficerUid === ctx.uid;
    const visible = isRo
      ? all
      : all.filter(
          (n) =>
            n.candidateUid === ctx.uid || n.nominatorUids.includes(ctx.uid),
        );
    return NextResponse.json({ nominations: visible });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/** POST nomination - signed in, on the frozen roll (route 7). */
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
    const nomination = await submitNomination(ctx.db, ctx.ports, electionId, {
      submitterUid: ctx.uid,
      candidateUid: body.candidateUid,
      candidateName: body.candidateName,
      nominatorUids: body.nominatorUids,
      candidateStatement: body.candidateStatement ?? "",
      consent: {
        driveFileId: body.consentDriveFileId,
        driveLink: body.consentDriveLink ?? "",
        fileName: body.consentFileName ?? "consent",
        sha256: body.consentSha256,
        uploadedByUid: ctx.uid,
      },
      campaignCodeAccepted: body.campaignCodeAccepted === true,
    });
    return NextResponse.json(
      { nominationId: nomination.id, status: nomination.status },
      { status: 201 },
    );
  } catch (err) {
    return electionErrorResponse(err);
  }
}
