/**
 * Sign and lock minutes (ws-a §4.6). canSignMinutes (the National
 * General Secretary by default). The service refuses unapproved
 * minutes BEFORE any PDF/Drive work; on success the record is
 * signed_locked with the Drive file id, the SHA-256 of the exact PDF
 * bytes, and retentionUntil = signedAt + 10 years.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { signMinutesService } from "@/lib/server/governance/minutes";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ minutesId: string }> },
) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireGovPermission(req, "canSignMinutes");
    const { minutesId } = await params;
    const deps = getGovernanceRouteDeps();
    const { record, pdf } = await signMinutesService(
      { store: deps.minutesStore, motions: deps.motions, pdfPipeline: deps.minutesPdfPipeline },
      { minutesId, signedBy: uid, at: new Date() },
    );
    return NextResponse.json({ success: true, minutes: record, pdf });
  } catch (e) {
    return govErrorResponse(e);
  }
}
