/**
 * Circulate minutes to the meeting's attendees (ws-a §4.6).
 * canManageMeetings. Attendee notification list = the meeting's present
 * members from the attendance record.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { circulateMinutesService } from "@/lib/server/governance/minutes";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";
import { GovernanceServiceError } from "@/lib/server/governance/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ minutesId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    await requireGovPermission(req, "canManageMeetings");
    const { minutesId } = await params;
    const deps = getGovernanceRouteDeps();
    const rec = await deps.minutesStore.getMinutes(minutesId);
    if (!rec) throw new GovernanceServiceError("minutes_not_found", 404, "Minutes not found");
    const attendeeUids = await deps.attendance.listPresentUids(rec.meetingId);
    const minutes = await circulateMinutesService(
      { store: deps.minutesStore, motions: deps.motions, pdfPipeline: deps.minutesPdfPipeline },
      { minutesId, attendeeUids, at: new Date() },
    );
    return NextResponse.json({ success: true, minutes });
  } catch (e) {
    return govErrorResponse(e);
  }
}
