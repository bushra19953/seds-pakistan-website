import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/server/firebase-admin";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
  verifySession,
  toSessionErrorResponse,
  SessionError,
} from "@/lib/auth/verifySession";
import {
  computeVenueEconomics,
  type VenueEconomicsInput,
} from "@/lib/events/venue-calculator";
import { getEventFromSupa } from "@/lib/supa-events/admin-events";

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
  return role === "president_national" || role === "superadmin" || role === "founder_patron";
}

function isTreasurerRole(role: string): boolean {
  return role === "treasurer" || role === "finance" || role === "superadmin" || role === "founder_patron";
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
  const canManage = await hasServerPermissionForUser(db, decoded.uid, "canManageEvents");
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
//
// Supabase migration (E5): this plain read is served from fs_events via
// the admin-events seam when the 'settlement' surface is enabled, with
// Firestore fallback on any seam unavailability. POST/PATCH below are
// NOT migrated: their get -> lock-check -> update sequence enforces the
// EV-P10 dual-sign lock and stays on Firestore whole (MANUAL_LIST E5:
// the Postgres equivalent is one transaction with SELECT ... FOR UPDATE
// on the fs_events row, never an adapter read-modify-write).
export async function GET(request: NextRequest) {
  try {
    const { db } = await authorize(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing event id" }, { status: 400 });

    const supaRead = await getEventFromSupa(id, "settlement");
    if (supaRead) {
      if (!supaRead.found) return NextResponse.json({ error: "Event not found" }, { status: 404 });
      const data = supaRead.data;
      return NextResponse.json({
        settlement: (data.profitSettlement as ProfitSettlement) || null,
        eventTitle: data.title || data.name || id,
      });
    }

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
//
// Dual-sign lock (EV-P10): once BOTH sign-offs exist, the signed figures
// are immutable through this route. A POST that changes any of the four
// figures, or that carries signAs, is rejected 409 with no write; a POST
// that changes nothing is still accepted while the record is a draft.
// Once the settlement is reconciled, every POST is rejected 409: a
// reconciled ledger is final and must never flip back to "draft" here.
// There is no sign-off revocation or correction path in the codebase,
// so the lock is final through this API by design.
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

    // Dual-sign lock (EV-P10): reject before any write, so a rejected
    // POST leaves the stored record byte-identical.
    if (existing.status === "reconciled") {
      return NextResponse.json(
        { error: "Settlement is reconciled and locked; its signed figures can no longer be changed" },
        { status: 409 }
      );
    }
    if (existing.presidentSignoff && existing.treasurerSignoff) {
      if (body?.signAs) {
        return NextResponse.json(
          { error: "Settlement is locked: both sign-offs are already recorded and cannot be added to or replaced" },
          { status: 409 }
        );
      }
      const figuresChanged =
        input.grossTicketCount !== toNumber(existing.grossTicketCount ?? 0) ||
        input.ticketPrice !== toNumber(existing.ticketPrice ?? 0) ||
        input.capacity !== toNumber(existing.capacity ?? 0) ||
        input.complimentaryCount !== toNumber(existing.complimentaryCount ?? 0);
      if (figuresChanged) {
        return NextResponse.json(
          {
            error:
              "Settlement figures are locked: the President and Treasurer have both signed off on them, so they can no longer be changed",
          },
          { status: 409 }
        );
      }
    }

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
    // Recompute the complimentary cap from the stored figures instead
    // of trusting the stored flag, which may be stale (EV-P10). With the
    // POST lock above, the stored figures are the signed figures, so
    // this recomputation is over exactly what both officers certified.
    const storedEconomics = computeVenueEconomics({
      grossTicketCount: toNumber(settlement.grossTicketCount ?? 0),
      ticketPrice: toNumber(settlement.ticketPrice ?? 0),
      capacity: toNumber(settlement.capacity ?? 0),
      complimentaryCount: toNumber(settlement.complimentaryCount ?? 0),
    });
    if (storedEconomics.complimentaryCapExceeded) {
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
