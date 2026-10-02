import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/server/firebase-admin";
import { hasServerPermission } from "@/lib/server/permissions";
import {
  verifySession,
  toSessionErrorResponse,
  SessionError,
} from "@/lib/auth/verifySession";
import {
  computeVenueEconomics,
  type VenueEconomicsInput,
} from "@/lib/events/venue-calculator";

export interface Signoff {
  uid: string;
  email: string;
  at: string;
  role: string;
}

export interface ProfitSettlement {
  grossTicketCount: number;
  ticketPrice: number;
  capacity: number;
  complimentaryCount: number;
  grossRevenue: number;
  venueShare: number;
  sedsSurplus: number;
  complimentaryCapExceeded: boolean;
  presidentSignoff: Signoff | null;
  treasurerSignoff: Signoff | null;
  status: "draft" | "reconciled";
  updatedAt: unknown;
  reconciledAt?: unknown;
  reconciledBy?: string;
}

function isPresidentRole(role: string): boolean {
  return role === "president_national" || role === "superadmin";
}

function isTreasurerRole(role: string): boolean {
  return role === "treasurer" || role === "finance" || role === "superadmin";
}

async function getCallerRole(db: FirebaseFirestore.Firestore, uid: string): Promise<string> {
  const snap = await db.collection("roles").doc(uid).get();
  return snap.exists ? String(snap.data()?.role || "") : "";
}

async function authorize(request: NextRequest) {
  const decoded = await verifySession(request);
  const db = getDb();
  if (!db) {
    throw new SessionError("server_misconfigured: Database unavailable", 500);
  }
  const role = await getCallerRole(db, decoded.uid);
  const canManage = await hasServerPermission(role, "canManageEvents");
  if (!canManage) {
    throw new SessionError("forbidden: Insufficient role to manage event finances", 403);
  }
  return { decoded, db, role };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// GET ?id=<eventId> : read current settlement state
export async function GET(request: NextRequest) {
  try {
    const { db } = await authorize(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing event id" }, { status: 400 });
    const snap = await db.collection("events").doc(id).get();
    if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    const data = snap.data() || {};
    return NextResponse.json({
      settlement: (data.profitSettlement as ProfitSettlement) || null,
      eventTitle: data.title || data.name || id,
    });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// POST : save settlement draft, or record a dual-signatory sign-off.
// Body: { id, grossTicketCount, ticketPrice, capacity, complimentaryCount,
//         signAs?: "president" | "treasurer" }
export async function POST(request: NextRequest) {
  try {
    const { decoded, db, role } = await authorize(request);
    const body = await request.json();
    const id = String(body?.id || "");
    if (!id) return NextResponse.json({ error: "Missing event id" }, { status: 400 });

    const ref = db.collection("events").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    const existing = ((snap.data() || {}).profitSettlement || {}) as Partial<ProfitSettlement>;

    const input: VenueEconomicsInput = {
      grossTicketCount: toNumber(body?.grossTicketCount ?? existing.grossTicketCount ?? 0),
      ticketPrice: toNumber(body?.ticketPrice ?? existing.ticketPrice ?? 0),
      capacity: toNumber(body?.capacity ?? existing.capacity ?? 0),
      complimentaryCount: toNumber(body?.complimentaryCount ?? existing.complimentaryCount ?? 0),
    };
    const economics = computeVenueEconomics(input);

    const settlement: ProfitSettlement = {
      grossTicketCount: input.grossTicketCount,
      ticketPrice: input.ticketPrice,
      capacity: input.capacity,
      complimentaryCount: input.complimentaryCount,
      grossRevenue: economics.grossRevenue,
      venueShare: economics.venueShare,
      sedsSurplus: economics.sedsSurplus,
      complimentaryCapExceeded: economics.complimentaryCapExceeded,
      presidentSignoff: existing.presidentSignoff || null,
      treasurerSignoff: existing.treasurerSignoff || null,
      status: "draft",
      updatedAt: FieldValue.serverTimestamp(),
    };

    const signAs = body?.signAs;
    if (signAs === "president") {
      if (!isPresidentRole(role)) {
        return NextResponse.json({ error: "Only the President can sign as President" }, { status: 403 });
      }
      settlement.presidentSignoff = {
        uid: decoded.uid,
        email: decoded.email || "",
        at: new Date().toISOString(),
        role,
      };
    } else if (signAs === "treasurer") {
      if (!isTreasurerRole(role)) {
        return NextResponse.json({ error: "Only the Treasurer can sign as Treasurer" }, { status: 403 });
      }
      settlement.treasurerSignoff = {
        uid: decoded.uid,
        email: decoded.email || "",
        at: new Date().toISOString(),
        role,
      };
    } else if (signAs) {
      return NextResponse.json({ error: "Invalid signAs value" }, { status: 400 });
    }

    await ref.update({ profitSettlement: settlement });
    return NextResponse.json({ success: true, settlement });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// PATCH : mark settlement reconciled. Requires both sign-offs present with
// two distinct UIDs (true dual control), and the complimentary cap satisfied.
export async function PATCH(request: NextRequest) {
  try {
    const { db } = await authorize(request);
    const body = await request.json();
    const id = String(body?.id || "");
    if (!id) return NextResponse.json({ error: "Missing event id" }, { status: 400 });

    const ref = db.collection("events").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    const settlement = ((snap.data() || {}).profitSettlement || {}) as Partial<ProfitSettlement>;

    if (!settlement.presidentSignoff) {
      return NextResponse.json({ error: "Presidential sign-off is required before reconciliation" }, { status: 422 });
    }
    if (!settlement.treasurerSignoff) {
      return NextResponse.json({ error: "Treasury sign-off is required before reconciliation" }, { status: 422 });
    }
    if (settlement.presidentSignoff.uid === settlement.treasurerSignoff.uid) {
      return NextResponse.json(
        { error: "President and Treasurer sign-offs must come from two different people" },
        { status: 422 }
      );
    }
    if (settlement.complimentaryCapExceeded) {
      return NextResponse.json(
        { error: "Complimentary passes exceed the 10% capacity cap; adjust before reconciling" },
        { status: 422 }
      );
    }

    await ref.update({
      "profitSettlement.status": "reconciled",
      "profitSettlement.reconciledAt": FieldValue.serverTimestamp(),
      "profitSettlement.updatedAt": FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ success: true, status: "reconciled" });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
