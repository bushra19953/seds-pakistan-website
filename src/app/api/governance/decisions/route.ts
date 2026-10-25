/**
 * Decision register read surface (ws-a §4.9): list + single read of the
 * append-only `decisions` register. There is NO write method here —
 * entries are created only by the motions, circular, and urgent
 * services, and mutated only through their two owned transitions.
 * canViewGovernance; allowed while the governance switch is off.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { toDate } from "@/lib/server/governance/firestore-stores";
import { readDecisionsFromSupa } from "@/lib/server/governance/decisions-supa";
import { requireGovPermission, govErrorResponse } from "@/lib/server/governance/route-helpers";
import { GovernanceServiceError } from "@/lib/server/governance/shared";

const DATE_FIELDS = ["decidedAt", "effectiveAt", "ratifiedAt", "voidedAt", "voidEffectiveFrom", "retentionUntil"] as const;

/** Timestamps serialize as ISO strings (raw Timestamps break hydration). */
function serializeDecision(id: string, data: FirebaseFirestore.DocumentData) {
  const out: Record<string, unknown> = { id, ...data };
  for (const f of DATE_FIELDS) {
    const d = toDate(out[f]);
    out[f] = d ? d.toISOString() : null;
  }
  return out;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireGovPermission(req, "canViewGovernance");
    const url = new URL(req.url);
    const bodyId = url.searchParams.get("bodyId");
    const id = url.searchParams.get("id");
    // Supa seam (G4, 'decisions' surface): when the flag is on and the
    // adapter answers, the register reads come from Supabase; a null
    // result (flag off / unconfigured / adapter error) runs the
    // Firestore path below byte-identically.
    const supa = await readDecisionsFromSupa({ id, bodyId });
    if (supa) {
      if (id) {
        if (!supa.found) throw new GovernanceServiceError("decision_not_found", 404, "Decision not found");
        return NextResponse.json({ success: true, decision: serializeDecision(id, supa.doc!) });
      }
      const decisions = (supa.docs ?? []).map((d) => serializeDecision(String(d.id), d));
      return NextResponse.json({ success: true, decisions });
    }
    const db = getDb();
    if (!db) throw new GovernanceServiceError("firestore_unavailable", 503, "Admin SDK is not configured");
    if (id) {
      const snap = await db.collection("decisions").doc(id).get();
      if (!snap.exists) throw new GovernanceServiceError("decision_not_found", 404, "Decision not found");
      return NextResponse.json({ success: true, decision: serializeDecision(snap.id, snap.data()!) });
    }
    let query: FirebaseFirestore.Query = db.collection("decisions");
    if (bodyId) query = query.where("bodyId", "==", bodyId);
    const snap = await query.orderBy("decidedAt", "desc").limit(200).get();
    const decisions = snap.docs.map((d) => serializeDecision(d.id, d.data()));
    return NextResponse.json({ success: true, decisions });
  } catch (e) {
    return govErrorResponse(e);
  }
}
