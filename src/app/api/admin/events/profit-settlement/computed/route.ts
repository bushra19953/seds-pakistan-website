import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
  verifySession,
  toSessionErrorResponse,
  SessionError,
} from "@/lib/auth/verifySession";
import {
  venueShare,
  sedsSurplus,
  complimentaryCapCheck,
} from "@/lib/events/venue-calculator";
import {
  computeSettlementSales,
  eventBaseTicketPrice,
  eventCapacity,
  isVerifiedSale,
  type SettlementRegistrationLike,
} from "@/lib/events/settlement-sales";
import { eventLinkedProductId } from "@/lib/events/product-link";
import {
  getEventFromSupa,
  listRegistrationsFromSupa,
} from "@/lib/supa-events/admin-events";

/**
 * GET ?id=<eventId> : settlement figures COMPUTED from actual sales
 * (DEFECT 3).
 *
 * The sibling profit-settlement route serves and stores the manual
 * profitSettlement doc — a doc only the settlement panel's own form
 * ever writes, so real sales never reached the ledger (live retest
 * 2026-10-26: EV2 PAID TEST's confirmed, payment-verified PKR 500
 * registration showed as all zeros). This route is the ledger's
 * source of truth for figures: it reads the event doc, the event's
 * registrations subcollection, and — only for verified sales that
 * carry no amount — the linked store order / ticket product, and
 * computes count, revenue, base price and capacity with
 * src/lib/events/settlement-sales.ts. The 25/75 split itself is the
 * unchanged venue-calculator math, applied to the computed revenue.
 *
 * complimentaryCount is NOT computed: complimentary passes have no
 * system record, so the count stored on the settlement doc (the
 * panel's one manual adjustment) is carried through for the cap
 * check. Sign-offs, status and reconciliation stay on the sibling
 * route, untouched.
 *
 * Read discipline: one event doc get, one registrations list scoped
 * to this event's subcollection (the same read the attendees panel
 * already makes), plus single-doc gets only for verified sales
 * missing an amount (their linked order) and for the linked ticket
 * product when the event carries no price. No collection scans.
 * Supabase seam reads are reused where the admin-events seam already
 * provides them (event doc on the 'settlement' surface,
 * registrations on 'events-admin'), with the Firestore reads above
 * as the fallback, exactly like the sibling routes.
 */

async function authorize(request: NextRequest) {
  const decoded = await verifySession(request);
  const db = getDb();
  if (!db) {
    throw new SessionError("server_misconfigured: Database unavailable", 500);
  }
  const canManage = await hasServerPermissionForUser(db, decoded.uid, "canManageEvents");
  if (!canManage) {
    throw new SessionError("forbidden: Insufficient role to manage event finances", 403);
  }
  return { decoded, db };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

type Db = NonNullable<ReturnType<typeof getDb>>;

async function loadRegistrations(
  db: Db,
  eventId: string,
): Promise<Array<Record<string, unknown>>> {
  const supaRegs = await listRegistrationsFromSupa(eventId);
  if (supaRegs) return supaRegs;
  const snap = await db.collection("events").doc(eventId).collection("registrations").get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

/**
 * Resolve the linked order total for verified sales that carry no
 * amount of their own (the store checkout mirror writes orderId but
 * no amount). One doc get per such sale; sales with an amount never
 * trigger a read.
 */
async function withOrderTotals(
  db: Db,
  registrations: Array<Record<string, unknown>>,
): Promise<SettlementRegistrationLike[]> {
  const out: SettlementRegistrationLike[] = [];
  for (const reg of registrations) {
    const needsOrder =
      isVerifiedSale(reg) &&
      !toNumber(reg.amount) &&
      !toNumber(reg.totalPkr) &&
      !toNumber(reg.total) &&
      typeof reg.orderId === "string" &&
      reg.orderId !== "";
    if (!needsOrder) {
      out.push(reg);
      continue;
    }
    let orderTotalPkr = 0;
    try {
      const orderSnap = await db.collection("orders").doc(reg.orderId as string).get();
      if (orderSnap.exists) {
        const order = orderSnap.data() || {};
        orderTotalPkr = toNumber(order.totalPkr) || toNumber(order.total);
      }
    } catch {
      // An unreadable order must not sink the ledger: the sale falls
      // back to the event base price in the computation.
    }
    out.push({ ...reg, orderTotalPkr });
  }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    const { db } = await authorize(request);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing event id" }, { status: 400 });

    let eventData: Record<string, unknown> | null = null;
    const supaRead = await getEventFromSupa(id, "settlement");
    if (supaRead) {
      if (!supaRead.found) return NextResponse.json({ error: "Event not found" }, { status: 404 });
      eventData = supaRead.data;
    } else {
      const snap = await db.collection("events").doc(id).get();
      if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
      eventData = snap.data() || {};
    }

    // Base price: the event's own payment amount first; the linked
    // ticket product's price when the event carries none.
    let ticketPrice = eventBaseTicketPrice(eventData);
    if (!ticketPrice) {
      const productId = eventLinkedProductId(eventData);
      if (productId) {
        const productSnap = await db.collection("products").doc(productId).get();
        if (productSnap.exists) ticketPrice = toNumber(productSnap.data()?.price);
      }
    }

    const capacity = eventCapacity(eventData);
    const registrations = await withOrderTotals(db, await loadRegistrations(db, id));
    const sales = computeSettlementSales(registrations, ticketPrice);

    const stored = (eventData.profitSettlement || {}) as Record<string, unknown>;
    const complimentaryCount = toNumber(stored.complimentaryCount ?? 0);

    return NextResponse.json({
      eventTitle: eventData.title || eventData.name || id,
      computed: {
        grossTicketCount: sales.grossTicketCount,
        ticketPrice,
        capacity,
        complimentaryCount,
        grossRevenue: sales.grossRevenue,
        venueShare: venueShare(sales.grossRevenue),
        sedsSurplus: sedsSurplus(sales.grossRevenue),
        complimentaryCapExceeded: complimentaryCapCheck(complimentaryCount, capacity),
      },
    });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
