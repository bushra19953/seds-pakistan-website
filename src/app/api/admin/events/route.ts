import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { hasServerPermissionForUser } from "@/lib/server/permissions";
import {
  verifySession,
  toSessionErrorResponse,
  SessionError,
} from "@/lib/auth/verifySession";
import { listEventsFromSupa } from "@/lib/supa-events/admin-events";

/**
 * Supabase-backed list read for the admin events registry page
 * (RBT2-A3; seam: src/lib/supa-events/admin-events.ts).
 *
 * GET ?limit=<n> — serves the events list from fs_events via the
 * admin-events seam ('events-admin' surface), newest first, when the
 * surface is enabled. When the surface is off or Supabase is
 * unavailable it answers 503 { error: "supa_unavailable" } and the
 * page activates its bounded Firestore fallback: flag OFF is exactly
 * the pre-seam behavior apart from the fallback's limit.
 *
 * The page previously ran an UNBOUNDED client Firestore query
 * (collection('events'), orderBy createdAt desc, no limit) with no
 * seam fetch at all. This route is the seam path; `limit` defaults
 * to 200 and is clamped to [1, 500] — the interim bound the page's
 * fallback query shares.
 *
 * Auth is identical to the registrations route: a verified session
 * plus the canManageEvents permission.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

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
    const rawLimit = Number(request.nextUrl.searchParams.get("limit"));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const events = await listEventsFromSupa(limit);
    if (!events) {
      return NextResponse.json({ error: "supa_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ events });
  } catch (err) {
    return toSessionErrorResponse(err) || NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
