import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
  verifySession,
  toSessionErrorResponse,
  SessionError,
} from "@/lib/auth/verifySession";
import {
  adminEventsSupaEnabled,
  getEventFromSupa,
  listRegistrationsFromSupa,
  mirrorRegistrationUpdate,
} from "@/lib/supa-events/admin-events";
import {
  syncLinkedStoreOrder,
  type LinkedOrderSyncOutcome,
  type RegistrationOrderState,
  type RegistrationVerifyAction,
} from "@/lib/events/registration-order-sync";

/**
 * Supabase-backed read + mirror endpoint for the admin attendees panel
 * (events cluster, E5; seam: src/lib/supa-events/admin-events.ts).
 *
 * GET ?eventId=<id> — serves the panel's registrations list from
 * fs_group_registrations (and the event capacity from fs_events) when the
 * 'events-admin' surface is enabled. When the surface is off or Supabase
 * is unavailable it answers 503 { error: "supa_unavailable" } and the
 * panel silently keeps its Firestore data: flag OFF is exactly today's
 * behavior. Auth is identical to the profit-settlement route: a verified
 * session plus the canManageEvents permission.
 *
 * POST { eventId, registrationId, fields } — dual-write mirror for the
 * panel's registration updates (verify payment / confirm seat / cancel),
 * called AFTER the Firestore update succeeded. Only the two status
 * fields the panel ever writes are accepted; updatedAt is stamped
 * server-side. The mirror never fails the request: it answers 200 with
 * { mirrored } either way, because the Firestore write is the primary.
 * The follow-on event counter sync is NOT mirrored (MANUAL_LIST E5).
 *
 * POST mode 'primary' — the panel's write itself: the Firestore update,
 * the mirror, the counter sync, and (Defect 2) the linked Store order
 * convergence all run inside this one server call; the order-sync
 * outcome is reported as { orderSync } in the response.
 */

async function authorize(request: NextRequest) {
  const decoded = await verifySession(request);
  const db = getDb();
  if (!db) {
    throw new SessionError("server_misconfigured: Database unavailable", 500);
  }
  const canManage = await hasServerPermissionForUser(db, decoded.uid, "canManageEvents");
  if (!canManage) {
    throw new SessionError("forbidden: Insufficient role to manage events", 403);
  }
  return { decoded, db };
}

export async function GET(request: NextRequest) {
  try {
    await authorize(request);
    const eventId = request.nextUrl.searchParams.get("eventId");
    if (!eventId) return NextResponse.json({ error: "Missing event id" }, { status: 400 });

    const registrations = await listRegistrationsFromSupa(eventId);
    if (!registrations) {
      return NextResponse.json({ error: "supa_unavailable" }, { status: 503 });
    }
    const eventRead = await getEventFromSupa(eventId, "events-admin");
    const capacity =
      eventRead?.found && typeof eventRead.data.capacity === "number"
        ? eventRead.data.capacity
        : null;
    return NextResponse.json({ registrations, capacity });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

const MIRRORED_FIELDS = ["status", "paymentStatus"] as const;

export async function POST(request: NextRequest) {
  try {
    const { db } = await authorize(request);
    const body = await request.json();
    const eventId = String(body?.eventId || "");
    const registrationId = String(body?.registrationId || "");
    if (!eventId || !registrationId) {
      return NextResponse.json({ error: "Missing eventId or registrationId" }, { status: 400 });
    }

    // WS10 'primary' mode: the attendees panel's write itself (its
    // client updateDoc + this route's mirror call + the client-side
    // counter sync collapsed into one server call). The Firestore
    // update lands FIRST with the panel's exact fields + updatedAt,
    // then the same mirror this route always performed, then the
    // counter sync computed from the server-read event doc with the
    // panel helper's exact array rule (registrationsCount =
    // attendeeIds.length). The counter sync stays unmirrored (E5).
    if (body?.mode === "primary") {
      const fields: Record<string, unknown> = {};
      for (const key of MIRRORED_FIELDS) {
        if (typeof body?.fields?.[key] === "string") fields[key] = body.fields[key];
      }
      if (Object.keys(fields).length === 0) {
        return NextResponse.json({ error: "No updatable fields" }, { status: 400 });
      }
      const { FieldValue } = await import("firebase-admin/firestore");
      await db
        .collection("events")
        .doc(eventId)
        .collection("registrations")
        .doc(registrationId)
        .update({ ...fields, updatedAt: FieldValue.serverTimestamp() });
      await mirrorRegistrationUpdate(eventId, registrationId, {
        ...fields,
        updatedAt: new Date(),
      });

      const counterSync = body?.counterSync as { uid?: unknown; mode?: unknown } | undefined;
      if (counterSync && typeof counterSync.uid === "string" && counterSync.uid) {
        const mode = counterSync.mode === "remove" ? "remove" : "add";
        const eventRef = db.collection("events").doc(eventId);
        const snap = await eventRef.get();
        const data = (snap.data() || {}) as Record<string, any>;
        const clean = (v: any): string[] =>
          Array.isArray(v) ? v.filter((x: any) => typeof x === "string") : [];
        const attendeeIds = clean(data.attendeeIds);
        const registeredUids = clean(data.registered_attendees_uids);
        const uid = counterSync.uid;
        const nextAttendeeIds =
          mode === "add"
            ? attendeeIds.includes(uid)
              ? attendeeIds
              : [...attendeeIds, uid]
            : attendeeIds.filter((x) => x !== uid);
        const nextRegisteredUids =
          mode === "add"
            ? registeredUids.includes(uid)
              ? registeredUids
              : [...registeredUids, uid]
            : registeredUids.filter((x) => x !== uid);
        await eventRef.update({
          attendeeIds: nextAttendeeIds,
          registered_attendees_uids: nextRegisteredUids,
          registrationsCount: nextAttendeeIds.length,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      // Defect 2 — the linked Store order convergence runs HERE, not in
      // the browser. The attendees panel used to converge the order with
      // a client updateDoc on 'orders' after this call; that bypassed
      // the server seam (and the WS10 pin bars client Firestore writes
      // in the events client files), so the sync moved into this primary
      // handler with D2's exact semantics: the shared convergence runs
      // on the registration's POST-write state, which for the field this
      // call did not touch is identical to the snapshot the panel used
      // to compute from. Verify/confirm trigger it; cancel never did
      // and still does not. Best-effort like the mirror above: the
      // registration write is the primary outcome, a sync failure is
      // logged and reported as orderSync: 'error', never hidden and
      // never fatal. The orders doc is never mirrored (registrations
      // parity contract) — Firestore is its only home.
      let orderSync: LinkedOrderSyncOutcome | "error" | null = null;
      const verifyAction: RegistrationVerifyAction | null =
        fields.paymentStatus === "verified"
          ? "verifyPayment"
          : fields.status === "confirmed"
            ? "confirmSeat"
            : null;
      if (verifyAction) {
        try {
          const regSnap = await db
            .collection("events")
            .doc(eventId)
            .collection("registrations")
            .doc(registrationId)
            .get();
          const raw = (regSnap.data() || {}) as Record<string, unknown>;
          const asString = (v: unknown) => (typeof v === "string" ? v : undefined);
          const regState: RegistrationOrderState = {
            status: asString(raw.status),
            paymentStatus: asString(raw.paymentStatus),
            orderId: asString(raw.orderId),
            transactionId: asString(raw.transactionId),
          };
          orderSync = await syncLinkedStoreOrder(regState, verifyAction, {
            orderExists: async (id) =>
              (await db.collection("orders").doc(id).get()).exists,
            findOrderIdByTransactionId: async (txn) => {
              const snap = await db
                .collection("orders")
                .where("transactionId", "==", txn)
                .limit(1)
                .get();
              return snap.empty ? null : snap.docs[0].id;
            },
            updateOrder: async (id, orderFields) => {
              await db
                .collection("orders")
                .doc(id)
                .update({ ...orderFields, updatedAt: FieldValue.serverTimestamp() });
            },
          });
          if (orderSync === "not-found") {
            console.warn(
              `[registrations] no linked Store order found for registration ${registrationId}`,
            );
          }
        } catch (syncErr) {
          console.error("[registrations] linked Store order sync failed:", syncErr);
          orderSync = "error";
        }
      }
      return NextResponse.json({ ok: true, mirrored: adminEventsSupaEnabled(), orderSync });
    }
    const fields: Record<string, unknown> = {};
    for (const key of MIRRORED_FIELDS) {
      if (typeof body?.fields?.[key] === "string") fields[key] = body.fields[key];
    }
    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ mirrored: false });
    }
    await mirrorRegistrationUpdate(eventId, registrationId, {
      ...fields,
      updatedAt: new Date(),
    });
    return NextResponse.json({ mirrored: adminEventsSupaEnabled() });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
