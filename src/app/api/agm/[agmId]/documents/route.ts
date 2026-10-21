import { NextRequest, NextResponse } from "next/server";
import {
  requireRouteContext,
  assertElectionsEnabled,
  electionErrorResponse,
  isFounderUid,
} from "@/lib/server/election-route-helpers";
import { addAgmDocument, listAgmDocuments } from "@/lib/server/agm";
import { resolveCanonicalRole } from "@/lib/server/permissions";

export const dynamic = "force-dynamic";

/**
 * GET documents (route 21). Full-Member-only documents are hidden from
 * non-Full Members; Drive links are never returned to non-Full
 * Members (server module enforces).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string }> },
) {
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const { agmId } = await params;
    const isFull = await ctx.ports.fullMembers.isFullMember(ctx.uid);
    const documents = await listAgmDocuments(ctx.db, agmId, { isFullMember: isFull });
    return NextResponse.json({ documents });
  } catch (err) {
    return electionErrorResponse(err);
  }
}

/**
 * POST document metadata - National General Secretary or National
 * Audit and Compliance Chair (route 21).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agmId: string }> },
) {
  const disabled = assertElectionsEnabled();
  if (disabled) return disabled;
  const ctx = await requireRouteContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const role = await resolveCanonicalRole(ctx.db, ctx.uid);
    const allowed =
      isFounderUid(ctx.uid) ||
      role === "national_general_secretary" ||
      role === "national_audit_compliance_chair";
    if (!allowed) {
      return NextResponse.json(
        { error: "Forbidden", code: "forbidden" },
        { status: 403 },
      );
    }
    const { agmId } = await params;
    const body = await request.json();
    const doc = await addAgmDocument(ctx.db, agmId, ctx.uid, {
      kind: body.kind,
      title: body.title,
      driveFileId: body.driveFileId,
      driveLink: body.driveLink,
      fileName: body.fileName,
      sha256: body.sha256,
      sizeBytes: body.sizeBytes ?? 0,
      sourceModule: body.sourceModule ?? "manual_upload",
    });
    return NextResponse.json({ document: doc }, { status: 201 });
  } catch (err) {
    return electionErrorResponse(err);
  }
}
