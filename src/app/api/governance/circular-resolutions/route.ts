/**
 * Circular resolutions (ws-a §4.7).
 * POST: create a DRAFT (canManageMeetings, Board-only in v1 — the
 * service returns 422 circular_board_only for other bodies). Nothing is
 * voted on until the circulate call.
 * GET: list all resolutions (canViewGovernance).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGovernanceRouteDeps } from "@/lib/server/governance/firestore-stores";
import { createCircularDraft, noopCircularNotifier } from "@/lib/server/governance/circular";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { requireGovernanceEnabled } from "@/lib/server/governance/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const createBody = z.object({
  bodyId: z.string().min(1),
  title: z.string().min(1).max(300),
  decisionClassId: z.string().min(1),
  text: z.string().min(1).max(4000),
  consentId: z.string().nullable().optional(),
});

function circularDeps() {
  const deps = getGovernanceRouteDeps();
  return {
    store: deps.circularStore,
    bodies: deps.bodies,
    classes: deps.classes,
    consents: deps.consents,
    decisions: deps.decisions,
    filingTasks: deps.filingTasks,
    notifier: noopCircularNotifier,
    newId: () => deps.circularStore.nextId(),
  };
}

export async function POST(req: NextRequest) {
  try {
    await requireGovernanceEnabled();
    const uid = await requireGovPermission(req, "canManageMeetings");
    const body = createBody.parse(await req.json());
    const resolution = await createCircularDraft(circularDeps(), {
      ...body,
      consentId: body.consentId ?? null,
      createdBy: uid,
      at: new Date(),
    });
    return NextResponse.json({ success: true, resolution }, { status: 201 });
  } catch (e) {
    return govErrorResponse(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const deps = getGovernanceRouteDeps();
    const resolutions = await deps.circularStore.listResolutions();
    return NextResponse.json({ success: true, resolutions });
  } catch (e) {
    return govErrorResponse(e);
  }
}
