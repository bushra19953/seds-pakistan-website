/**
 * One minutes record (ws-a §4.6).
 * GET: read (canViewGovernance; allowed while disabled).
 * PATCH: NGS supplementary edits only (canManageMeetings). The patch is
 * validated by the lifecycle guard: generated sec 3.5 fields refuse with
 * 422 generated_field_immutable, other record fields refuse as
 * immutable, and a signed record refuses everything (409).
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { editMinutes } from "@/lib/server/governance/minutes";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";
import { GovernanceServiceError } from "@/lib/server/governance/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ minutesId: string }> },
) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const { minutesId } = await params;
    const deps = getGovernanceRouteDeps();
    const rec = await deps.minutesStore.getMinutes(minutesId);
    if (!rec) throw new GovernanceServiceError("minutes_not_found", 404, "Minutes not found");
    return NextResponse.json({ success: true, minutes: rec });
  } catch (e) {
    return govErrorResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ minutesId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireGovPermission(req, "canManageMeetings");
    const { minutesId } = await params;
    // The body passes through UNFILTERED on purpose: unknown and
    // generated keys must reach the lifecycle guard so it can refuse
    // them with its precise error codes instead of a generic 400.
    const patch = (await req.json()) as Record<string, unknown>;
    const deps = getGovernanceRouteDeps();
    const minutes = await editMinutes(
      { store: deps.minutesStore, motions: deps.motions, pdfPipeline: deps.minutesPdfPipeline },
      { minutesId, patch, editorUid: uid, at: new Date() },
    );
    return NextResponse.json({ success: true, minutes });
  } catch (e) {
    return govErrorResponse(e);
  }
}
