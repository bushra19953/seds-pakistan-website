import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { getResult } from "@/lib/server/election-count";
import { getElectionOrThrow, millisOf } from "@/lib/server/election-db";
import { buildElectionCertificatePdf } from "@/lib/election-certificate-pdf";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/**
 * GET certificate PDF (route 16). Gate: RO, National General
 * Secretary, Founder, Governors; after declaration, any Full Member.
 * The PDF is regenerated deterministically from the declared result
 * (the signature binds the same payload), and is served only through
 * this gated route - never a public Drive link.
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
    const result = await getResult(ctx.db, electionId);
    if (!result) {
      return NextResponse.json(
        { error: "No certificate exists before declaration.", code: "not_declared" },
        { status: 404 },
      );
    }
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const governorRoles = ["governor_member", "governor_founder", "governor_coopted"];
    const privileged =
      isFounderUid(ctx.uid) ||
      election.returningOfficerUid === ctx.uid ||
      role === "national_general_secretary" ||
      governorRoles.includes(role);
    if (!privileged) {
      const isFull = await ctx.ports.fullMembers.isFullMember(ctx.uid);
      if (!isFull) {
        return NextResponse.json(
          { error: "Full Members only.", code: "full_member_required" },
          { status: 403 },
        );
      }
    }

    const candidateNames: Record<string, string> = {};
    for (const e of result.elected) candidateNames[e.candidateUid] = e.name;
    const { pdfBytes, sha256 } = await buildElectionCertificatePdf({
      electionId,
      electionTitle: election.title,
      seats: election.seats,
      elected: result.elected.map((e) => ({
        candidateUid: e.candidateUid,
        name: e.name,
        votes: e.votes,
      })),
      tallies: result.totals.tallies,
      candidateNames,
      tieLotId: result.tieLotId,
      returningOfficerName: election.returningOfficerName,
      returningOfficerUid: election.returningOfficerUid,
      declaredAtMillis: millisOf(result.declaredAt),
      verificationUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://sedspakistan.live"}/elections/${electionId}`,
    });
    if (sha256 !== result.certificate.sha256) {
      return NextResponse.json(
        { error: "Certificate verification failed.", code: "certificate_mismatch" },
        { status: 500 },
      );
    }
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="election-certificate-${electionId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
